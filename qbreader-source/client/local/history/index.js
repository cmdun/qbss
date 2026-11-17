const list = document.getElementById('sessions');
const detail = document.getElementById('session-detail');

async function refresh () {
  const response = await fetch('/api/local/history');
  const { sessions } = await response.json();
  list.replaceChildren();
  document.getElementById('empty-state').classList.toggle('d-none', sessions.length > 0);
  for (const session of sessions) {
    const button = document.createElement('button');
    button.className = 'list-group-item list-group-item-action text-start';
    const when = new Date(session.startedAt).toLocaleString();
    button.textContent = `${when} · ${session.mode} · ${session.questionCount} questions · ${session.correctCount} tossups correct · ${session.totalPoints} pts`;
    button.addEventListener('click', () => showSession(session.id));
    list.append(button);
  }
}

async function showSession (id) {
  const response = await fetch(`/api/local/history/${id}`);
  const session = await response.json();
  detail.replaceChildren();
  const heading = document.createElement('h2');
  heading.textContent = `${session.mode} session`;
  detail.append(heading);
  const summary = document.createElement('p');
  const categories = Object.entries(session.categorySummary ?? {}).map(([category, values]) => `${category}: ${values.correct}/${values.count} correct, ${values.points} pts`);
  summary.textContent = `${session.questionCount} questions · ${session.correctCount} tossups correct · ${session.totalPoints} points${categories.length ? ` · ${categories.join(' · ')}` : ''}`;
  detail.append(summary);
  const table = document.createElement('div');
  table.className = 'list-group';
  for (const item of session.questions) {
    const row = document.createElement('div');
    row.className = 'list-group-item';
    const question = item.question ?? {};
    const set = question.set?.name ?? question.set_name ?? 'Local packet';
    const prompt = (question.question ?? question.leadin ?? 'Question').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    row.textContent = `${item.questionType} · ${set} · ${item.category ?? 'Uncategorized'} · ${item.outcome ?? 'unanswered'}${item.points === null ? '' : ` · ${item.points}/${item.possiblePoints} pts`} — ${prompt}`;
    table.append(row);
  }
  detail.append(table);
}

refresh().catch(error => window.alert(`Could not load history: ${error.message}`));
