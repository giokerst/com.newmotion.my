# Experimental 50five email 2FA — 4.1.27

This branch adds the portal's email verification to Homey pairing and repair. The owner confirmed successful email-code login on Homey with version 4.1.27 on 7 October 2026. This is not a Homey App Store release; charger commands and long-running session behaviour still need separate verification.

## What changes

- Pairing/Repair asks for the six-digit email code when the portal requires it.
- Login preserves one cookie jar through `/Login/Login`, `/2fa`, and `/2fa_check`, including the CSRF token and cookie rotation.
- Authentication is checked against the dashboard and the read-only chargepoint-list request. Receiving a cookie alone does not mean login succeeded.
- Credentials and the verified cookie jar are saved with the app's existing device-bound encryption. The OTP itself is not saved or logged. Existing credentials are replaced only after successful verification.
- Devices share the driver's session. Session cookies keep their original expiry metadata across restarts; there is no unconditional hourly re-login.
- On expiry, background requests stop and Homey requests Repair. This avoids repeated login emails. Commands are never automatically replayed after an ambiguous response.
- Pairing and repair UI text is available in Dutch and English; detailed portal errors currently use English.

## Development checks

Use Node.js compatible with the installed Homey CLI (development checks used Node 24).

```sh
npm ci
npm test
npx homey app build
npx homey app validate --level publish
```

The tests use synthetic responses only; they are not evidence of successful login to a real 50five account. Existing `build/` contents are a historical upstream directory; use the repository root and the Homey CLI build output, not that directory.

## Install for a real Homey test

Clone this fork and check out `test/email-2fa`. Authenticate the Homey CLI and select the intended Homey before using `npx homey app install` from the repository root. The CLI must be able to reach your Homey. Being able to use the Homey mobile app remotely does not guarantee CLI installation will work from outside your home network.

**This branch retains app ID `com.newmotion.my`. Installing it replaces the existing app on the selected Homey; it does not create a second independent test app.** Do not uninstall the existing app or use a clean install, since that can remove its devices/flows. Record your current version and make a Homey backup before choosing to install. A GitHub PR itself does not install anything.

## Manual acceptance checklist

Email-code login through Repair has been confirmed by the owner. The remaining checks below have not yet been confirmed.

1. Open Repair on an existing chargepoint. Sign in with the appropriate HTTPS country portal, then enter the email code. Incorrect or expired codes should remain on the verification step with a clear error; use Back to login to request another code.
2. Confirm charger status and cards load. Complete the new-device pairing route separately if needed.
3. Restart the app and check whether the saved session is reused without a new email. Check both after an hour and on the next day. Record when the server actually requires a new code; no session lifetime is promised.
4. With the car connected and when appropriate, test a deliberate start and stop. Test block/unblock only if the charger already supports the app's pause setting. No current/ampere control is added by this PR.
5. When the session expires, check that polling does not send repeated email codes, the repair notification appears, and an attempted charging command fails rather than reporting success. Repair should restore access for every device using this account.
6. Cancel an incomplete login and verify that existing verified credentials remain unchanged.

Use your own account directly in Homey. Do not put passwords, codes, cookies, charger addresses or unsanitized logs into a GitHub issue/PR.

## Protocol research

- https://github.com/wilbiev/evcnet (email OTP support introduced in 1.1.4)
- https://github.com/Platzii/homeassistant-evcnet/pull/39
- https://50five.com/nl/nl/consumer (six-digit email code, valid for 10 minutes)

The JavaScript implementation is written for this Homey app; these sources provided protocol references. Firmware, country portals and server session policies may differ. Homey hardware validation and long-running session testing remain required before merging or publishing.
