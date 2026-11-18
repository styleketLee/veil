import { useEffect, useMemo, useRef, useState } from 'react';
import { cloud, deviceStatus, prepareDevice, quick, CLOUD_MODEL, DEVICE_OFF, type DeviceStatus } from './lib/ai';
import { deviceDetect, mergeEntities, patternDetect, type Entity } from './lib/detect';
import { pieces, redact } from './lib/redact';
import { SAMPLES } from './lib/samples';

type Where = 'device' | 'cloud' | 'pattern';
interface Trace { label: string; where: Where; saw: 'original' | 'redacted'; ms: number }
interface Answer { question: string; text: string; where: Where; mode: 'quick' | 'deep'; error?: string }

const QUICK_QUESTIONS = [
  'Summarize this in three bullet points.',
  'What am I agreeing to or being asked to pay?',
  'Which deadlines and amounts should I watch?',
  'Draft a short, polite reply.',
];

const TYPE_LABEL: Record<string, string> = {
  PERSON: 'Person', ADDRESS: 'Address', ORGANIZATION: 'Organization', ID_NUMBER: 'ID number',
  DATE_OF_BIRTH: 'Date of birth', OTHER: 'Other', EMAIL: 'Email', PHONE: 'Phone', CARD: 'Card number',
  SSN: 'SSN', ACCOUNT: 'Account number', CUSTOM: 'Hidden by you',
};

export default function App() {
  const [doc, setDoc] = useState('');
  const [phase, setPhase] = useState<'edit' | 'scanning' | 'review'>('edit');
  const [entities, setEntities] = useState<Entity[]>([]);
  const [device, setDevice] = useState<DeviceStatus | 'checking'>('checking');
  const [status, setStatus] = useState('');
  const [notice, setNotice] = useState('');
  const [trace, setTrace] = useState<Trace[]>([]);
  const [question, setQuestion] = useState('');
  const [mode, setMode] = useState<'quick' | 'deep'>('deep');
  const [asking, setAsking] = useState(false);
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [selection, setSelection] = useState('');
  const originalRef = useRef<HTMLDivElement>(null);

  useEffect(() => { deviceStatus().then(setDevice); }, []);

  const { redacted, map } = useMemo(() => redact(doc, entities), [doc, entities]);
  const hiddenCount = Object.keys(map).length;
  const addTrace = (t: Trace) => setTrace((prev) => [...prev, t]);

  async function scan() {
    if (!doc.trim()) return;
    setPhase('scanning');
    setNotice('');
    setAnswers([]);
    setTrace([]);
    const t0 = performance.now();
    const fromPatterns = patternDetect(doc);
    addTrace({ label: 'Pattern scan (emails, phones, card and account numbers)', where: 'pattern', saw: 'original', ms: Math.round(performance.now() - t0) });
    let fromDevice: Entity[] = [];
    if (device !== 'unavailable' && device !== 'checking') {
      try {
        setStatus(device === 'available' ? 'Starting the on-device model…' : 'Downloading the on-device model (first time only)…');
        await prepareDevice((f) => setStatus(`Downloading the on-device model… ${Math.round(f * 100)}%`));
        setDevice('available');
        const t1 = performance.now();
        fromDevice = await deviceDetect(doc, (done, total) => setStatus(`Reading on this device… part ${done} of ${total}`));
        addTrace({ label: 'Names, addresses, organizations and IDs (Gemini Nano)', where: 'device', saw: 'original', ms: Math.round(performance.now() - t1) });
      } catch (e) {
        setNotice(`The on-device model could not run (${errorText(e)}). Only pattern-based hiding was applied, so check names and addresses yourself.`);
      }
    } else {
      setNotice('This browser has no on-device model, so Veil only hid structured identifiers. Select names and addresses in the original and hide them yourself before asking.');
    }
    setEntities(mergeEntities(fromPatterns, fromDevice));
    setStatus('');
    setPhase('review');
  }

  async function ask(q: string) {
    const text = q.trim();
    if (!text || asking) return;
    setAsking(true);
    setQuestion('');
    const prompt = `Document (some details are hidden behind placeholders):\n"""\n${redacted}\n"""\n\nQuestion: ${text}`;
    const t0 = performance.now();
    try {
      const result = await (mode === 'quick' && !DEVICE_OFF ? quick : cloud).generateContent(prompt);
      const where: Where = result.response.inferenceSource === 'on_device' ? 'device' : 'cloud';
      addTrace({ label: mode === 'quick' ? 'Quick answer' : `Deep analysis (${CLOUD_MODEL})`, where, saw: 'redacted', ms: Math.round(performance.now() - t0) });
      setAnswers((prev) => [{ question: text, text: result.response.text(), where, mode }, ...prev]);
    } catch (e) {
      setAnswers((prev) => [{ question: text, text: '', where: 'cloud', mode, error: errorText(e) }, ...prev]);
    } finally {
      setAsking(false);
    }
  }

  function toggle(text: string) {
    setEntities((prev) => prev.map((e) => (e.text === text ? { ...e, hidden: !e.hidden } : e)));
  }

  function hideSelection() {
    const t = selection.trim();
    if (!t || !doc.includes(t)) return;
    setEntities((prev) => mergeEntities(prev.filter((e) => !t.includes(e.text)), [{ text: t, type: 'CUSTOM', source: 'you', hidden: true }]));
    setSelection('');
    window.getSelection()?.removeAllRanges();
  }

  function onSelect() {
    const sel = window.getSelection();
    const node = originalRef.current;
    if (!sel || !node || sel.isCollapsed || !node.contains(sel.anchorNode) || !node.contains(sel.focusNode)) { setSelection(''); return; }
    setSelection(sel.toString());
  }

  function reset(text = '') {
    setDoc(text); setPhase('edit'); setEntities([]); setAnswers([]); setTrace([]); setNotice(''); setSelection('');
  }

  return (
    <div className="page">
      <header className="top">
        <div className="brand">
          <span className="mark" aria-hidden="true" />
          <div>
            <h1>Veil</h1>
            <p>Ask the cloud about a private document, without showing it your secrets.</p>
          </div>
        </div>
        <DeviceBadge status={device} />
      </header>

      {phase !== 'review' && (
        <section className="card intake">
          <div className="row between">
            <h2>1. Paste a document</h2>
            <div className="samples">
              <span>Try a sample:</span>
              {SAMPLES.map((s) => (
                <button key={s.id} className="chip" onClick={() => setDoc(s.text)} disabled={phase === 'scanning'}>{s.title}</button>
              ))}
            </div>
          </div>
          <textarea
            value={doc}
            onChange={(e) => setDoc(e.target.value)}
            placeholder="A lease, a medical bill, a payslip, an email thread…"
            spellCheck={false}
            disabled={phase === 'scanning'}
          />
          <div className="row between">
            <p className="hint">Nothing leaves this page yet. The scan runs inside your browser.</p>
            <button className="primary" onClick={scan} disabled={!doc.trim() || phase === 'scanning' || device === 'checking'}>
              {phase === 'scanning' ? status || 'Scanning…' : 'Scan on this device'}
            </button>
          </div>
        </section>
      )}

      {phase === 'review' && (
        <>
          {notice && <p className="notice">{notice}</p>}
          <section className="grid">
            <div className="card">
              <div className="row between">
                <h2><span className="dot device" />Original <small>stays on this device</small></h2>
                <button className="ghost" onClick={() => reset(doc)}>Edit</button>
              </div>
              <div className="doc" ref={originalRef} onMouseUp={onSelect} onKeyUp={onSelect}>
                <Highlighted text={doc} entities={entities} />
              </div>
              <div className="row between">
                <p className="hint">Missed something? Select it above.</p>
                <button className="ghost strong" onClick={hideSelection} disabled={!selection.trim()}>
                  {selection.trim() ? `Hide “${clip(selection.trim(), 22)}”` : 'Hide selection'}
                </button>
              </div>
            </div>

            <div className="card">
              <div className="row between">
                <h2><span className="dot cloud" />What the cloud will see</h2>
                <span className="count">{hiddenCount} hidden</span>
              </div>
              <div className="doc mono">
                {pieces(redacted, map).map((p, i) =>
                  p.kind === 'text' ? <span key={i}>{p.value}</span> : (
                    <button key={i} className="ph" title={`Hidden: ${p.original}. Click to show it to the cloud.`} onClick={() => p.original && toggle(p.original)}>{p.value}</button>
                  ),
                )}
              </div>
              <p className="hint">Click a placeholder to reveal it. Read this panel before you ask: it is exactly what will be sent.</p>
            </div>

            <div className="card">
              <h2>Hidden details</h2>
              <ul className="entities">
                {entities.length === 0 && <li className="hint">Nothing was detected.</li>}
                {entities.map((e) => (
                  <li key={e.text}>
                    <label>
                      <input type="checkbox" checked={e.hidden} onChange={() => toggle(e.text)} />
                      <span className="etext">{e.text}</span>
                    </label>
                    <span className={`tag ${e.source}`}>{TYPE_LABEL[e.type] ?? e.type}</span>
                  </li>
                ))}
              </ul>
              <Legend />
            </div>
          </section>

          <section className="card ask">
            <h2>2. Ask about it</h2>
            <div className="modes" role="radiogroup" aria-label="Where to answer">
              <label className={mode === 'deep' ? 'on' : ''}>
                <input type="radio" name="mode" checked={mode === 'deep'} onChange={() => setMode('deep')} />
                <b>Deep analysis</b><span>Cloud model reads the redacted text</span>
              </label>
              <label className={mode === 'quick' ? 'on' : ''}>
                <input type="radio" name="mode" checked={mode === 'quick'} onChange={() => setMode('quick')} />
                <b>Quick answer</b><span>On this device when possible, cloud otherwise</span>
              </label>
            </div>
            <div className="quick">
              {QUICK_QUESTIONS.map((q) => <button key={q} className="chip" onClick={() => ask(q)} disabled={asking}>{q}</button>)}
            </div>
            <form className="row" onSubmit={(e) => { e.preventDefault(); ask(question); }}>
              <input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Ask anything about this document" disabled={asking} />
              <button className="primary" disabled={asking || !question.trim()}>{asking ? 'Thinking…' : 'Ask'}</button>
            </form>

            {answers.map((a, i) => (
              <article key={answers.length - i} className="answer">
                <div className="row between">
                  <h3>{a.question}</h3>
                  <span className={`where ${a.where}`}>{a.where === 'device' ? 'Answered on this device' : 'Answered in the cloud'}</span>
                </div>
                {a.error ? <p className="error">The request failed: {a.error}</p> : (
                  <div className="answer-text">
                    {pieces(tidy(a.text), map).map((p, k) =>
                      p.kind === 'text' ? <Rich key={k} text={p.value} /> : (
                        <mark key={k} title={`The model only saw ${p.value}`}>{p.original ?? p.value}</mark>
                      ),
                    )}
                  </div>
                )}
                {!a.error && <p className="hint">Highlighted words were put back on this device. The model only saw their placeholders.</p>}
              </article>
            ))}
          </section>

          <section className="card">
            <h2>Where each step ran</h2>
            <table className="trace">
              <thead><tr><th>Step</th><th>Ran</th><th>Saw</th><th>Time</th></tr></thead>
              <tbody>
                {trace.map((t, i) => (
                  <tr key={i}>
                    <td>{t.label}</td>
                    <td><span className={`where ${t.where}`}>{t.where === 'cloud' ? 'Cloud' : 'This device'}</span></td>
                    <td>{t.saw === 'original' ? 'Original text' : 'Redacted text only'}</td>
                    <td>{(t.ms / 1000).toFixed(1)} s</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button className="ghost" onClick={() => reset()}>Start over</button>
          </section>
        </>
      )}

      <footer>
        <p>Veil keeps no copy of your document. Automatic detection can miss things, so always read the middle panel before asking.</p>
        <p>Built with Firebase AI Logic hybrid inference: Gemini Nano in Chrome on your device, Gemini in the cloud.</p>
      </footer>
    </div>
  );
}

function DeviceBadge({ status }: { status: DeviceStatus | 'checking' }) {
  const text = {
    checking: 'Checking this device…',
    available: 'On-device model ready',
    downloadable: 'On-device model available (downloads on first scan)',
    downloading: 'On-device model downloading',
    unavailable: 'No on-device model in this browser',
  }[status];
  return <span className={`badge ${status}`}>{text}</span>;
}

function Legend() {
  return (
    <p className="legend">
      <span><span className="tag pattern">pattern</span> found by fixed rules</span>
      <span><span className="tag device">device</span> found by the on-device model</span>
      <span><span className="tag you">you</span> hidden by hand</span>
    </p>
  );
}

function Highlighted({ text, entities }: { text: string; entities: Entity[] }) {
  const spans = useMemo(() => {
    const owner: (Entity | null)[] = new Array(text.length).fill(null);
    for (const e of [...entities].sort((a, b) => b.text.length - a.text.length)) {
      let i = -1;
      while ((i = text.indexOf(e.text, i + 1)) !== -1) {
        let free = true;
        for (let k = i; k < i + e.text.length; k++) if (owner[k]) { free = false; break; }
        if (free) for (let k = i; k < i + e.text.length; k++) owner[k] = e;
      }
    }
    const out: { value: string; entity: Entity | null }[] = [];
    for (let i = 0; i < text.length; i++) {
      const last = out[out.length - 1];
      if (last && last.entity === owner[i]) last.value += text[i];
      else out.push({ value: text[i], entity: owner[i] });
    }
    return out;
  }, [text, entities]);
  return <>{spans.map((s, i) => (s.entity ? <span key={i} className={s.entity.hidden ? 'hl' : 'hl off'}>{s.value}</span> : <span key={i}>{s.value}</span>))}</>;
}

/** Models answer in light Markdown. Bullets become dots and headings lose their marks. */
const tidy = (s: string) => s.replace(/^[ \t]*[*-] +/gm, '• ').replace(/^#{1,6} +/gm, '');

/** Renders **bold** runs; everything else is plain text. */
function Rich({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*\n]+\*\*)/g);
  return <>{parts.map((part, i) => (part.startsWith('**') && part.endsWith('**') && part.length > 4 ? <b key={i}>{part.slice(2, -2)}</b> : <span key={i}>{part.replace(/\*\*/g, '')}</span>))}</>;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
