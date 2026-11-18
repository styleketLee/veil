# Veil

**Ask the cloud about a private document, without showing it your secrets.**

People paste leases, medical bills, payslips and email threads into cloud AI tools every day. Names, addresses and account numbers go along for the ride. Veil puts a small model on your own device in front of the cloud: it finds the personal details, replaces them with placeholders, shows you exactly what will be sent, and only then asks the cloud model. The answer comes back with placeholders, and Veil puts the real values back locally.

Built for the Firebase **#BuildHybridAI** hackathon with [Firebase AI Logic](https://firebase.google.com/docs/ai-logic) hybrid inference.

Live demo: https://veil-hybrid-ec821.web.app · Source: https://github.com/styleketLee/veil

## How it works

| Step | Where it runs | What it sees |
|---|---|---|
| 1. Pattern scan (emails, phones, card, SSN, account numbers) | Your device, plain code | Original text |
| 2. Names, addresses, organizations, free-form IDs | Your device, Gemini Nano (`ONLY_ON_DEVICE`) | Original text |
| 3. You review "What the cloud will see", hide more or reveal | Your device | Both |
| 4a. Quick answer | Your device when possible (`PREFER_ON_DEVICE`) | Redacted text only |
| 4b. Deep analysis | Cloud Gemini (`ONLY_IN_CLOUD`) | Redacted text only |
| 5. Placeholders in the answer are swapped back | Your device | Both |

The one rule in the code: **the original text is only ever given to the `ONLY_ON_DEVICE` model.** That model cannot fall back to the cloud, by design. If a browser has no on-device model, Veil does not quietly send the document to the cloud to be scanned. It hides what fixed patterns can find, tells you so, and lets you hide the rest by hand.

A table at the bottom of the page records where every step ran and what it saw.

## Hybrid inference in the code

All three models are defined in [`src/lib/ai.ts`](src/lib/ai.ts):

- `detector` — `InferenceMode.ONLY_ON_DEVICE`, with a JSON schema (`responseConstraint`) so Gemini Nano returns a typed list of spans.
- `quick` — `InferenceMode.PREFER_ON_DEVICE`, falls back to the cloud model.
- `cloud` — `InferenceMode.ONLY_IN_CLOUD`.

`result.response.inferenceSource` is read after each call to show where the answer really came from. Detection is in [`src/lib/detect.ts`](src/lib/detect.ts), redaction and restoring in [`src/lib/redact.ts`](src/lib/redact.ts).

Firebase products used: AI Logic (Gemini Developer API backend), App Check (reCAPTCHA Enterprise on the deployed site, debug token locally), Hosting.

Veil has no server and no database. The document lives in page memory and is gone when you close the tab.

## Try it

1. Open the live demo in Chrome on a desktop (version 139 or later).
2. Click a sample, for example **Medical bill**, then **Scan on this device**. The first scan downloads Gemini Nano, which can take a few minutes.
3. Read the middle panel. Select any text in the original to hide it, or click a placeholder to reveal it.
4. Ask a question in **Deep analysis** or **Quick answer** mode.

To see the behavior on a browser without an on-device model, add `?device=off` to the URL.

All sample documents are fictional.

## Limits

- Automatic detection misses things. On five test documents with 54 personal details, patterns and Gemini Nano together fully hid 52. That is why the review panel is the core of the product, not an extra.
- English documents only for now.
- Text only. PDFs and images are not supported.
- Hiding a detail also hides it from the model, so answers that depend on that detail will be less specific.

## Run locally

```bash
npm install
cp .env.example .env.local   # then add an App Check debug token
npm run dev
```

To use your own Firebase project, replace the values in `src/firebaseConfig.ts`, enable the Gemini Developer API in Firebase AI Logic, and register the web app with App Check.

```bash
npm run build
npx firebase-tools deploy --only hosting
```

## License

Apache-2.0. See [LICENSE](LICENSE).
