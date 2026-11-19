# Code signing for Windows releases

Unsigned installers make Windows SmartScreen show *"Windows protected your PC"* before Ron Assistant installs, and again for every update. Signing removes that warning (for a new signing identity, SmartScreen may still warn briefly until the publisher builds reputation).

The build chooses how to sign from the environment (see `electron-builder.config.js`):

| Order | Method | What must be set |
|---|---|---|
| 1 | **Microsoft Artifact Signing** (formerly Trusted Signing) | Repository **variables** `ARTIFACT_SIGNING_ENDPOINT`, `ARTIFACT_SIGNING_ACCOUNT`, `ARTIFACT_SIGNING_PROFILE`, `ARTIFACT_SIGNING_PUBLISHER`, and repository **secrets** `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` |
| 2 | A code-signing certificate file (.pfx) | Secrets `CSC_LINK` (the file, base64) and `CSC_KEY_PASSWORD` |
| 3 | Unsigned | Nothing; the release workflow prints a warning |

Nothing is signed until you set one of these up. Both options cost money and need your identity verified, so they are yours to set up; this repository is ready for either.

## Option 1: Microsoft Artifact Signing (usually the cheapest)

Microsoft runs the certificate for you; you pay a monthly fee per account (two tiers, with quotas of 5,000 and 100,000 signatures a month at the time of writing). Billing starts when the account is created and is not pro-rated. **Check the current price and whether individuals are eligible in your country on the [pricing page](https://azure.microsoft.com/en-us/pricing/details/artifact-signing/) before you start.**

1. In the Azure portal, create an **Artifact Signing account** (note its **endpoint**, for example `https://eus.codesigning.azure.net`, and the account **name**).
2. Complete **identity validation** for yourself (public trust). This can take a few days.
3. Create a **certificate profile** (Public Trust) and note its name. The **publisher name** is the name that was validated (it appears as the program's publisher in Windows).
4. Create an **app registration** in Microsoft Entra ID with a client secret, and give it the **Certificate Profile Signer** role on the signing account (listed as *Artifact Signing Certificate Profile Signer*, or *Trusted Signing Certificate Profile Signer* under the service's older name). Note the tenant ID, client ID and secret value.
5. In GitHub → the repository → *Settings → Secrets and variables → Actions*:
   - **Variables:** `ARTIFACT_SIGNING_ENDPOINT`, `ARTIFACT_SIGNING_ACCOUNT`, `ARTIFACT_SIGNING_PROFILE`, `ARTIFACT_SIGNING_PUBLISHER`
   - **Secrets:** `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`
6. Push a version tag (for example `v0.3.0`). The release workflow says *"Microsoft Artifact Signing is configured"* and electron-builder installs Microsoft's `TrustedSigning` PowerShell module and signs the app, installer and portable exe.

To sign a local build instead, set the same seven values as environment variables in PowerShell and run `npm run dist:win`.

## Option 2: a certificate from a certificate authority

Since 2023, publicly trusted code-signing certificates are issued on hardware tokens or cloud HSMs, so a plain `.pfx` file is rarely available for new certificates. If you do have one: base64-encode it into the `CSC_LINK` secret and put its password in `CSC_KEY_PASSWORD`. For token- or HSM-based certificates, follow the vendor's signing tool instructions; electron-builder's `win.signtoolOptions` can call it.

## Checking a signed build

Right-click the installer → *Properties* → *Digital Signatures*: the publisher name should be listed. Or in PowerShell:

```powershell
Get-AuthenticodeSignature .\release\Ron-Assistant-Setup-0.3.0-x64.exe | Format-List Status, SignerCertificate
```

`Status` should be `Valid`.

## What was verified here

The three branches of `electron-builder.config.js` produce the expected settings, and an unsigned build was produced. **No signed build has been made**: that needs an Artifact Signing account or a certificate.
