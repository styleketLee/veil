// Firebase AI Logic setup. Three models, one rule:
//   raw text is only ever given to the ONLY_ON_DEVICE model.
import { initializeApp } from 'firebase/app';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check';
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode } from 'firebase/ai';
import { firebaseConfig, RECAPTCHA_ENTERPRISE_SITE_KEY } from '../firebaseConfig';

export const CLOUD_MODEL = import.meta.env.VITE_CLOUD_MODEL || 'gemini-3.5-flash-lite';

const app = initializeApp(firebaseConfig);

if (import.meta.env.DEV) {
  // Local development uses an App Check debug token (register it in the Firebase console).
  (self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN: string | boolean }).FIREBASE_APPCHECK_DEBUG_TOKEN =
    import.meta.env.VITE_APPCHECK_DEBUG_TOKEN || true;
}
initializeAppCheck(app, {
  provider: new ReCaptchaEnterpriseProvider(RECAPTCHA_ENTERPRISE_SITE_KEY),
  isTokenAutoRefreshEnabled: true,
});

const ai = getAI(app, { backend: new GoogleAIBackend() });

const EN = [{ type: 'text' as const, languages: ['en'] }];
const system = (value: string) => [{ role: 'system' as const, content: [{ type: 'text' as const, value }] }];

export const DETECT_SYSTEM = `You find personal or identifying information in a document so it can be hidden.
Return every span that identifies a specific person or organisation:
- PERSON: names of people, with titles if attached (e.g. "Dr. Jane Poe"), including first names used alone
- ADDRESS: street addresses, including unit, city, state and postal code
- ORGANIZATION: names of companies, banks, hospitals, insurers, employers
- ID_NUMBER: account, routing, member, patient, employee, case and claim numbers
- DATE_OF_BIRTH: dates of birth only
Copy each span exactly as written in the document, character for character.
Do not return amounts of money, ordinary dates, or generic words.`;

export const DETECT_SCHEMA = {
  type: 'object',
  properties: {
    entities: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          type: { type: 'string', enum: ['PERSON', 'ADDRESS', 'ORGANIZATION', 'ID_NUMBER', 'DATE_OF_BIRTH', 'OTHER'] },
        },
        required: ['text', 'type'],
      },
    },
  },
  required: ['entities'],
};

export const ANSWER_SYSTEM = `You help a person understand a document they pasted.
Some details were hidden before the document reached you. They appear as placeholders such as [PERSON_1] or [ID_NUMBER_2].
Rules:
- Use the placeholders exactly as written whenever you refer to a hidden detail. Never guess what is behind them.
- Answer in plain language. Be specific about amounts, dates and obligations that are visible in the document.
- If the document does not contain the answer, say so.`;

// 1. Detector: sees the raw document, so it must never fall back to the cloud.
export const detector = getGenerativeModel(ai, {
  mode: InferenceMode.ONLY_ON_DEVICE,
  onDeviceParams: {
    createOptions: { initialPrompts: system(DETECT_SYSTEM), expectedInputs: EN, expectedOutputs: EN },
    promptOptions: { responseConstraint: DETECT_SCHEMA },
  },
});

// 2. Quick answers: sees only the redacted document, so either place is safe.
export const quick = getGenerativeModel(ai, {
  mode: InferenceMode.PREFER_ON_DEVICE,
  onDeviceParams: { createOptions: { initialPrompts: system(ANSWER_SYSTEM), expectedInputs: EN, expectedOutputs: EN } },
  inCloudParams: { model: CLOUD_MODEL, systemInstruction: ANSWER_SYSTEM },
});

// 3. Deep analysis: redacted document, always in the cloud.
export const cloud = getGenerativeModel(ai, {
  mode: InferenceMode.ONLY_IN_CLOUD,
  inCloudParams: { model: CLOUD_MODEL, systemInstruction: ANSWER_SYSTEM },
});

/** `?device=off` shows how Veil behaves in a browser without an on-device model. */
export const DEVICE_OFF = new URLSearchParams(globalThis.location?.search ?? '').get('device') === 'off';

export type DeviceStatus = 'available' | 'downloadable' | 'downloading' | 'unavailable';

export async function deviceStatus(): Promise<DeviceStatus> {
  const LM = (globalThis as unknown as { LanguageModel?: { availability(o?: object): Promise<string> } }).LanguageModel;
  if (!LM || DEVICE_OFF) return 'unavailable';
  try {
    const s = await LM.availability({ expectedInputs: EN, expectedOutputs: EN });
    return s === 'available' || s === 'downloadable' || s === 'downloading' ? s : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

/** Must be called from a user gesture. May download the model the first time. */
export function prepareDevice(onProgress?: (fraction: number) => void) {
  return detector.initializeDeviceModel(onProgress);
}
