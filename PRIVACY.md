# Privacy policy

AURES is an open-source command-line tool for macOS. It has no server of its own, collects nothing and sends nothing to its author or to any third party. The source code is at <https://github.com/Keshaqaz/aures>.

## Google user data

The worker runs on Google Apps Script in your own Google account. To install it, AURES asks you to sign in to Google and requests these scopes:

- `https://www.googleapis.com/auth/script.projects` — to create the worker's Apps Script project in your own Google account and upload its code;
- `https://www.googleapis.com/auth/script.deployments` — to deploy that project as a web app and update the deployment on upgrade;
- `openid` and `https://www.googleapis.com/auth/userinfo.email` — to show which Google account the worker runs in.

AURES uses these permissions only to install, repair, update and remove the worker in your account, at your command. It does not read, create or change any other Apps Script projects, files or data in your account.

The Google access and refresh tokens are stored only in your Mac's Keychain. They are sent only to Google (`accounts.google.com`, `oauth2.googleapis.com`, `script.googleapis.com`) and never to the author or anyone else. AURES does not sell, share or transfer Google user data, does not use it for advertising, and does not use it to train AI or machine-learning models. No human reads it.

AURES's use and transfer of information received from Google APIs adheres to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.

## Other data

- The worker's ChatGPT sign-in is stored in the properties of the Apps Script project in your account. The worker sends it only to OpenAI.
- The worker secret is stored in your Mac's Keychain.
- AURES has no telemetry and no analytics.

## Deleting your data

`aures uninstall` removes the tokens from your Keychain and revokes the Google sign-in. Delete the worker's Apps Script project at <https://script.google.com>. You can also revoke AURES's access at any time at <https://myaccount.google.com/permissions>.

## Contact

Questions: nnadelyaev@gmail.com or <https://github.com/Keshaqaz/aures/issues>.

Last updated: 27 October 2026.
