const list = document.getElementById('packet-list');
const preview = document.getElementById('preview');
let pendingPacket;
let pendingFilename;

async function refresh () {
  const response = await fetch('/api/local/packets');
  const { packets } = await response.json();
  list.replaceChildren();
  document.getElementById('empty-state').classList.toggle('d-none', packets.length > 0);
  for (const packet of packets) {
    const row = document.createElement('div');
    row.className = 'list-group-item d-flex flex-wrap align-items-center gap-2';
    const title = document.createElement('span');
    title.className = 'me-auto';
    title.textContent = `${packet.name} — ${packet.tossupCount} tossups, ${packet.bonusCount} bonuses`;
    row.append(title);
    if (packet.tossupCount) { row.append(linkButton('Play tossups', `/play/combined/?type=tossups&packetId=${encodeURIComponent(packet.id)}`)); }
    if (packet.bonusCount) { row.append(linkButton('Play bonuses', `/play/combined/?type=bonuses&packetId=${encodeURIComponent(packet.id)}`)); }
    row.append(linkButton('Play both', `/play/combined/?type=combined&packetId=${encodeURIComponent(packet.id)}`, true));
    const remove = document.createElement('button');
    remove.className = 'btn btn-outline-danger btn-sm';
    remove.textContent = 'Remove';
    remove.addEventListener('click', async () => {
      await fetch(`/api/local/packets/${packet.id}`, { method: 'DELETE' });
      await refresh();
    });
    row.append(remove);
    list.append(row);
  }
}

function linkButton (label, href, primary = false) {
  const link = document.createElement('a');
  link.className = `btn btn-sm ${primary ? 'btn-primary' : 'btn-outline-primary'}`;
  link.href = href;
  link.textContent = label;
  return link;
}

document.getElementById('import-form').addEventListener('submit', async event => {
  event.preventDefault();
  const file = document.getElementById('packet-file').files[0];
  if (!file) { return; }
  try {
    const packet = JSON.parse(await file.text());
    if (!Array.isArray(packet.tossups) || !Array.isArray(packet.bonuses)) {
      throw new Error('The JSON needs tossups and bonuses arrays.');
    }
    pendingPacket = packet;
    pendingFilename = file.name;
    preview.replaceChildren();
    const heading = document.createElement('strong');
    heading.textContent = packet.name || file.name;
    const details = document.createElement('p');
    details.className = 'mb-2';
    details.textContent = `${packet.tossups.length} tossups and ${packet.bonuses.length} bonuses. The packet will be saved locally.`;
    const save = document.createElement('button');
    save.className = 'btn btn-success align-self-start';
    save.textContent = 'Save packet';
    save.addEventListener('click', async () => {
      const response = await fetch('/api/local/packets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packet: pendingPacket, filename: pendingFilename })
      });
      if (!response.ok) { window.alert('The packet could not be saved.'); return; }
      preview.classList.add('d-none');
      document.getElementById('import-form').reset();
      await refresh();
    });
    preview.append(heading, details, save);
    preview.classList.remove('d-none');
  } catch (error) {
    window.alert(`Could not read packet: ${error.message}`);
  }
});

refresh().catch(error => window.alert(`Could not load local packets: ${error.message}`));
