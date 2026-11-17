/* global JSZip, saveAs */
import Parser from '/node_modules/qb-packet-parser/dist/main.browser.mjs';

let zip;

function createDownloadGroupItem (data, filename) {
  const { tossups, bonuses } = data;
  const wrapper = document.createElement('li');
  wrapper.className = 'list-group-item d-flex flex-wrap align-items-center gap-2';
  const a = document.createElement('a');
  a.className = 'me-auto';
  a.download = filename;
  a.href = '#';
  a.target = '_blank';
  a.textContent = `${filename} - ${tossups.length} tossups, ${bonuses.length} bonuses`;
  a.addEventListener('click', function (event) {
    event.preventDefault();
    event.stopPropagation();
    saveAs(new window.Blob([JSON.stringify(data, null, 4)], { type: 'application/json' }), filename);
  });
  const save = document.createElement('button');
  save.className = 'btn btn-success btn-sm';
  save.type = 'button';
  save.textContent = 'Save locally';
  save.addEventListener('click', async () => {
    const response = await fetch('/api/local/packets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ packet: data, filename })
    });
    if (response.ok) {
      save.textContent = 'Saved';
      save.disabled = true;
    } else {
      window.alert('Could not save this packet locally.');
    }
  });
  wrapper.append(a, save);
  return wrapper;
}

function fillWarnings (warnings, filename) {
  document.getElementById('warnings').classList.remove('d-none');
  const warningList = document.getElementById('warning-list');
  for (const warning of warnings) {
    const li = document.createElement('li');
    li.className = 'list-group-item';
    li.textContent = `${filename}: ${warning}`;
    warningList.appendChild(li);
  }
}

document.getElementById('form').addEventListener('submit', async function (e) {
  e.preventDefault();
  e.stopPropagation();

  const files = document.getElementById('file-input').files;
  if (files.length === 0) { return; }

  const parser = new Parser({
    hasCategoryTags: document.getElementById('has-category-tags').checked,
    hasQuestionNumbers: document.getElementById('has-question-numbers').checked,
    buzzpoints: document.getElementById('buzzpoint-format').checked,
    modaq: document.getElementById('modaq-format').checked
  });
  zip = new JSZip();

  const fileOutput = document.getElementById('file-output');
  fileOutput.innerHTML = '';
  document.getElementById('warning-list').innerHTML = '';

  for (const file of files) {
    const arrayBuffer = await file.arrayBuffer();
    try {
      const { data, warnings } = await parser.parseDocxPacket(arrayBuffer, file.name);
      const newFileName = file.name.replace(/\.docx$/, '.json');
      fileOutput.appendChild(createDownloadGroupItem(data, newFileName));
      zip.file(newFileName, JSON.stringify(data, null, 4));
      if (warnings.length > 0) {
        fillWarnings(warnings, newFileName);
      }
    } catch (e) {
      window.alert(`Error parsing ${file.name}: ${e.message}`);
    }
  }

  document.getElementById('download-all').classList.remove('d-none');
});

document.getElementById('download-all').addEventListener('click', function () {
  zip.generateAsync({ type: 'blob' }).then(function (content) {
    saveAs(content, 'output.zip');
  });
});
