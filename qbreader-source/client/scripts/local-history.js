let sessionId;
let sessionMode;
let sessionPromise;
let ordinal = 0;
let correctCount = 0;
let questionCount = 0;

function start (mode) {
  sessionMode = mode;
  sessionId = undefined;
  sessionPromise = undefined;
  ordinal = 0;
  correctCount = 0;
  questionCount = 0;
}

async function ensureSession () {
  if (sessionId) { return sessionId; }
  if (!sessionPromise) {
    sessionPromise = fetch('/api/local/history/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: sessionMode ?? 'Tossups' })
    }).then(async response => {
      if (!response.ok) { throw new Error('History session could not start'); }
      sessionId = (await response.json()).id;
      return sessionId;
    });
  }
  try {
    return await sessionPromise;
  } catch (error) {
    sessionPromise = undefined;
    console.warn('Local history could not start:', error);
  }
}

async function record (questionType, question, result = {}) {
  if (!question) { return; }
  const id = await ensureSession();
  if (!id) { return; }
  const currentOrdinal = ordinal++;
  questionCount++;
  if (result.outcome === 'correct') { correctCount++; }
  try {
    await fetch(`/api/local/history/sessions/${id}/questions/${currentOrdinal}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionType, question, ...result })
    });
  } catch (error) {
    console.warn('Local question history could not be saved:', error);
  }
}

async function finish () {
  if (!sessionId) { return; }
  const body = JSON.stringify({ correctCount, questionCount });
  try {
    await fetch(`/api/local/history/sessions/${sessionId}/finish`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true
    });
  } catch (error) {
    console.warn('Local history could not be finalized:', error);
  }
}

window.addEventListener('pagehide', finish);

export default { start, record, finish };
