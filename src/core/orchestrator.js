'use strict';
// Compare and Review-together flows. Bounded: one answer stage, at most two review rounds, one
// final stage. Every model call has its own timeout; one failure never blocks the others.
const crypto = require('node:crypto');
const { answerPrompt, reviewPrompt, finalPrompt, splitReview } = require('./prompts');
const { getProvider } = require('./adapters');

const MAX_REVIEW_ROUNDS = 2;
const STOPPED = 'cancelled';
const PARTIAL_MS = 150;

/** Identifies one box of streaming text in the window. */
function streamKey(stage, id, round) { return stage === 'review' ? `review:${id}:${round}` : `${stage}:${id}`; }

function now() { return Date.now(); }

/**
 * @param {object} deps
 * @param {(id:string, prompt:string, opts:object)=>Promise<string>} deps.ask
 * @param {(event:object)=>void} deps.emit
 */
function createOrchestrator({ ask, emit = () => {} }) {
  let active = null; // { run, controller }

  function nameOf(id) { try { return getProvider(id).name; } catch { return id; } }

  function update(run, patch) {
    Object.assign(run, patch);
    emit({ type: 'run', run: snapshot(run) });
  }

  function snapshot(run) { return JSON.parse(JSON.stringify(run)); }

  /**
   * Partial text while a model is still writing. Sent as its own small event (not a whole-run
   * snapshot) and at most every PARTIAL_MS per box; never stored in the run or history.
   */
  function partialSender(run, key) {
    let last = 0;
    return (text) => {
      const t = now();
      if (t - last < PARTIAL_MS) return;
      last = t;
      emit({ type: 'partial', runId: run.id, key, text });
    };
  }

  async function callModel(run, controller, { id, prompt, settings, slot, key }) {
    const started = now();
    slot.state = 'running'; slot.error = ''; slot.code = '';
    update(run, {});
    try {
      const text = await ask(id, prompt, { signal: controller.signal, timeoutSec: settings.timeoutSec || 180, model: settings.models?.[id]?.model || '', cwd: settings.workDir, onText: key ? partialSender(run, key) : undefined });
      Object.assign(slot, { state: 'done', text, ms: now() - started });
      return text;
    } catch (e) {
      const code = controller.signal.aborted ? STOPPED : (e.code || 'failed');
      Object.assign(slot, { state: code === STOPPED ? 'stopped' : 'failed', code, error: e.message || String(e), ms: now() - started });
      return null;
    } finally {
      update(run, {});
    }
  }

  async function answerStage(run, controller, settings, ids) {
    await Promise.all(ids.map((id) => {
      run.answers[id] = { id, name: nameOf(id), state: 'queued', text: '', error: '', code: '', ms: 0 };
      const prompt = answerPrompt({ question: run.question, instructions: settings.instructions, history: run.context });
      return callModel(run, controller, { id, prompt, settings, slot: run.answers[id], key: streamKey('answer', id) });
    }));
  }

  function latestAnswers(run) {
    // Latest text per model: its newest successful revised answer, else its independent answer.
    return Object.values(run.answers).filter((a) => a.state === 'done').map((a) => {
      const revised = [...run.reviews].reverse().find((r) => r.id === a.id && r.state === 'done' && r.revised);
      return { id: a.id, name: a.name, text: revised ? revised.revised : a.text };
    });
  }

  async function reviewAndFinal(run, controller, settings) {
    run.reviews = []; run.final = { state: 'queued', text: '', by: '', note: '', error: '' };
    update(run, { phase: 'review' });
    const rounds = Math.min(MAX_REVIEW_ROUNDS, Math.max(1, Number(settings.reviewRounds) || 1));
    run.reviewRounds = rounds;
    let participants = latestAnswers(run);
    if (participants.length >= 2) {
      for (let round = 1; round <= rounds && !controller.signal.aborted; round += 1) {
        const before = latestAnswers(run);
        await Promise.all(before.map((self) => {
          const slot = { id: self.id, name: self.name, round, state: 'queued', text: '', review: '', revised: '', error: '' };
          run.reviews.push(slot);
          const prompt = reviewPrompt({ question: run.question, instructions: settings.instructions, history: run.context, selfName: self.name, ownAnswer: self.text, answers: before, round });
          return callModel(run, controller, { id: self.id, prompt, settings, slot, key: streamKey('review', self.id, round) }).then((text) => {
            if (text) Object.assign(slot, splitReview(text));
          });
        }));
      }
      participants = latestAnswers(run);
    }
    if (controller.signal.aborted) return;
    update(run, { phase: 'final' });
    if (participants.length === 0) {
      Object.assign(run.final, { state: 'failed', error: 'No model produced an answer, so there is nothing to combine.' });
      return;
    }
    if (participants.length === 1) {
      Object.assign(run.final, { state: 'done', text: participants[0].text, by: participants[0].id, note: `Only ${participants[0].name} answered, so no review took place.` });
      return;
    }
    const order = synthOrder(settings.finalModel, participants.map((p) => p.id));
    const reviews = run.reviews.filter((r) => r.state === 'done').map((r) => ({ name: r.name, round: r.round, text: r.review || r.text }));
    for (const id of order) {
      if (controller.signal.aborted) return;
      const prompt = finalPrompt({ question: run.question, instructions: settings.instructions, history: run.context, synthName: nameOf(id), answers: participants, reviews });
      const slot = { id, name: nameOf(id), state: 'queued', text: '', error: '' };
      Object.assign(run.final, { state: 'running', by: id });
      const text = await callModel(run, controller, { id, prompt, settings, slot, key: streamKey('final', id) });
      if (text) {
        const tried = order.slice(0, order.indexOf(id));
        Object.assign(run.final, { state: 'done', text, by: id, note: tried.length ? `${tried.map(nameOf).join(', ')} could not write the final answer; ${nameOf(id)} did.` : '' });
        return;
      }
      run.final.error = slot.error;
    }
    if (!controller.signal.aborted) {
      // Every combiner failed: fall back to the best available answer rather than nothing.
      const p = participants[0];
      Object.assign(run.final, { state: 'done', text: p.text, by: p.id, note: `No model could combine the answers; showing ${p.name}'s answer instead.` });
    }
  }

  function synthOrder(preferred, available) {
    const list = [...available];
    if (preferred && preferred !== 'auto' && list.includes(preferred)) return [preferred, ...list.filter((x) => x !== preferred)];
    return list;
  }

  function overallStatus(run, controller) {
    if (controller.signal.aborted) return 'stopped';
    const answers = Object.values(run.answers);
    const ok = answers.filter((a) => a.state === 'done').length;
    if (!ok) return 'failed';
    if (run.mode === 'review' && run.final?.state !== 'done') return 'failed';
    return ok === answers.length ? 'complete' : 'partial';
  }

  async function execute(run, settings, work) {
    if (active) throw new Error('A question is already being answered. Stop it first.');
    const controller = new AbortController();
    active = { run, controller };
    try {
      update(run, { status: 'running' });
      await work(controller);
    } finally {
      active = null;
      update(run, { status: overallStatus(run, controller), phase: 'done', finishedAt: new Date().toISOString() });
    }
    return snapshot(run);
  }

  /** Ask a new question. */
  function start({ question, mode, models, settings, context = [], conversationId }) {
    const ids = [...new Set(models)].filter(Boolean);
    if (!String(question || '').trim()) return Promise.reject(new Error('Type a question first.'));
    if (!ids.length) return Promise.reject(new Error('Turn on at least one model.'));
    const run = {
      id: crypto.randomUUID(), conversationId: conversationId || crypto.randomUUID(), question: String(question).trim(),
      mode: mode === 'review' ? 'review' : 'compare', models: ids, context, createdAt: new Date().toISOString(),
      status: 'running', phase: 'answer', answers: {}, reviews: [], final: null,
    };
    return execute(run, settings, async (controller) => {
      await answerStage(run, controller, settings, ids);
      if (run.mode === 'review' && !controller.signal.aborted) await reviewAndFinal(run, controller, settings);
    });
  }

  /** Re-ask one model that failed; in Review mode the review and final answer are then redone. */
  function retry(previous, modelId, settings) {
    const run = snapshot(previous);
    if (!run.models.includes(modelId)) return Promise.reject(new Error('That model was not part of this question.'));
    return execute(run, settings, async (controller) => {
      update(run, { phase: 'answer' });
      await answerStage(run, controller, settings, [modelId]);
      if (run.mode === 'review' && !controller.signal.aborted) await reviewAndFinal(run, controller, settings);
    });
  }

  function stop() {
    if (!active) return false;
    active.controller.abort();
    return true;
  }

  return { start, retry, stop, isBusy: () => Boolean(active), MAX_REVIEW_ROUNDS };
}

module.exports = { createOrchestrator, streamKey, MAX_REVIEW_ROUNDS };
