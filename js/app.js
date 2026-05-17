/* =====================================================================
   app.js  –  UI 관리, 이벤트 핸들러, 브랜드 관리, 초기화
   ===================================================================== */

// ── localStorage 헬퍼 ─────────────────────────────────────────────────
const StorageHelper = {
  BRANDS_KEY:   'kw_brands',
  SETTINGS_KEY: 'kw_settings',

  getBrands() {
    try { return JSON.parse(localStorage.getItem(this.BRANDS_KEY)) || [...DEFAULT_BRANDS]; }
    catch { return [...DEFAULT_BRANDS]; }
  },
  saveBrands(brands) {
    localStorage.setItem(
      this.BRANDS_KEY,
      JSON.stringify([...new Set(brands.map(b => b.trim()).filter(Boolean))])
    );
  },
  getSettings() {
    try { return JSON.parse(localStorage.getItem(this.SETTINGS_KEY)) || {}; }
    catch { return {}; }
  },
  saveSettings(s) { localStorage.setItem(this.SETTINGS_KEY, JSON.stringify(s)); },
};

// ── 현재 분석 옵션 ────────────────────────────────────────────────────
function getAnalysisOptions() {
  const s = StorageHelper.getSettings();
  return {
    enableOpenAI: s.enableOpenAI !== false,
    openAiKey:    s.openAiKey    || '',
    openAiModel:  s.openAiModel  || 'gpt-4o',
  };
}

// ── 토스트 ────────────────────────────────────────────────────────────
function showToast(msg, type = 'info', duration = 3000) {
  const el = Object.assign(document.createElement('div'), {
    className: `toast toast-${type}`, textContent: msg,
  });
  document.getElementById('toastContainer').appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, duration);
}

// ── 결과 렌더링 ───────────────────────────────────────────────────────
function renderDirectResult(result) {
  const el = document.getElementById('directResult');
  if (!result) { el.innerHTML = ''; return; }

  if (result.skipped) {
    el.innerHTML = `
      <div class="result-card result-skipped">
        <div class="result-header">
          <span class="result-badge badge-skip">건너뜀</span>
          <span class="result-original">${esc(result.original)}</span>
        </div>
        <p class="result-reason">이유: ${esc(result.reason)}</p>
      </div>`;
    return;
  }

  const noteHtml = result.aiNote
    ? `<span class="step-note step-note-${result.aiNote === '오타 교정' ? 'typo' : 'syn'}">${esc(result.aiNote)}</span>`
    : '';
  const geminiRow = `
    <tr>
      <td class="step-label">AI 분석 결과 ${noteHtml}</td>
      <td class="step-value">${esc(result.aiResult)}</td>
    </tr>`;

  const outputHtml = result.output
    ? `<div class="result-output">
         <span class="output-label">제안 검색어</span>
         <span class="output-value">${esc(result.output)}</span>
       </div>`
    : `<div class="result-output result-empty">
         <span class="output-label">제안 검색어</span>
         <span class="output-empty">-</span>
       </div>`;

  el.innerHTML = `
    <div class="result-card">
      <div class="result-header">
        <span class="result-badge badge-done">분석 완료</span>
        <span class="result-original">${esc(result.original)}</span>
      </div>
      <table class="steps-table">${geminiRow}</table>
      ${outputHtml}
    </div>`;
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── 직접 입력 분석 ────────────────────────────────────────────────────
async function runDirectAnalysis() {
  const input   = document.getElementById('keywordInput');
  const keyword = input.value.trim();
  if (!keyword) { showToast('검색어를 입력해주세요.', 'warning'); return; }

  const btn = document.getElementById('analyzeBtn');
  btn.disabled = true; btn.textContent = '분석 중…';
  try {
    renderDirectResult(await analyzeKeyword(keyword, getAnalysisOptions()));
  } catch (e) {
    showToast('분석 오류: ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = '분석';
  }
}

// ── 파일 처리 ─────────────────────────────────────────────────────────
let parsedFileData  = null, resultWorkbook = null, originalFileName = '';
let stopRequested   = false;
let partialResults  = null;   // 중단 시 완료된 결과 보관, null = 미시작/완료

function resetFileState() {
  parsedFileData = null; resultWorkbook = null; partialResults = null;
  ['fileInfo','progressSection','downloadSection'].forEach(
    id => (document.getElementById(id).hidden = true)
  );
  const processBtn = document.getElementById('processFileBtn');
  processBtn.disabled    = true;
  processBtn.textContent = '파일 분석 시작';
  document.getElementById('dropZone').classList.remove('has-file');
}

async function handleFileSelect(file) {
  if (!file) return;
  if (!['xlsx','xls','csv'].includes(file.name.split('.').pop().toLowerCase())) {
    showToast('xlsx, xls, csv 파일만 지원합니다.', 'error'); return;
  }
  try {
    parsedFileData   = await parseFile(file);
    originalFileName = file.name.replace(/\.[^.]+$/, '');
    partialResults   = null;   // 새 파일이므로 이전 중단 이력 초기화
    document.getElementById('fileName').textContent =
      `${file.name}  (데이터 ${parsedFileData.rows.length}행)`;
    document.getElementById('fileInfo').hidden         = false;
    const processBtn = document.getElementById('processFileBtn');
    processBtn.disabled    = false;
    processBtn.textContent = '파일 분석 시작';
    document.getElementById('downloadSection').hidden  = true;
    document.getElementById('progressSection').hidden  = true;
    document.getElementById('dropZone').classList.add('has-file');
    showToast(`파일 로드: ${parsedFileData.rows.length}개 검색어`, 'success');
  } catch (e) { showToast(e.message, 'error'); resetFileState(); }
}

async function runFileAnalysis() {
  if (!parsedFileData) return;

  const isResume  = partialResults !== null;
  const startFrom = isResume ? partialResults.length : 0;
  stopRequested   = false;

  const processBtn = document.getElementById('processFileBtn');
  const stopBtn    = document.getElementById('stopFileBtn');
  processBtn.disabled = true;
  stopBtn.disabled    = false;

  const total    = parsedFileData.rows.length;
  const progSec  = document.getElementById('progressSection');
  const progFill = document.getElementById('progressFill');
  const progText = document.getElementById('progressText');
  progSec.hidden = false;
  document.getElementById('downloadSection').hidden = true;

  // 재개 시 이미 완료된 진행률부터 표시
  const alreadyDone = startFrom;
  progFill.style.width = Math.round(alreadyDone / total * 100) + '%';
  progText.textContent = `${alreadyDone} / ${total}`;

  try {
    const { results: newResults, stopped } = await processRows(
      parsedFileData.rows, getAnalysisOptions(),
      (done, tot) => {
        const totalDone = alreadyDone + done;
        progFill.style.width = Math.round(totalDone / tot * 100) + '%';
        progText.textContent = `${totalDone} / ${tot}`;
      },
      () => stopRequested,
      startFrom
    );

    // 이전 결과 + 이번 결과 합산
    const allResults = isResume ? [...partialResults, ...newResults] : newResults;

    if (!allResults.length) {
      showToast('분석된 결과가 없습니다.', 'warning');
      return;
    }

    resultWorkbook = buildResultWorkbook(parsedFileData, allResults);
    const suggested = allResults.filter(r => r.output).length;
    const doneCount = allResults.length;

    if (stopped) {
      partialResults = allResults;   // 중단 → 재개를 위해 보관
      processBtn.textContent = '이어서 분석';
      document.getElementById('downloadTitle').textContent =
        `⏹ 중단됨 — ${doneCount}행까지 완료. 결과 파일을 다운로드하세요.`;
      document.getElementById('downloadStat').textContent =
        `처리 ${doneCount} / ${total}행 · 제안 ${suggested}개`;
      showToast(`중단됨 — ${doneCount}행 완료. "이어서 분석"으로 재개할 수 있습니다.`, 'warning', 4000);
    } else {
      partialResults = null;   // 완료 → 초기화
      processBtn.textContent = '파일 분석 시작';
      document.getElementById('downloadTitle').textContent =
        isResume ? '재개 후 분석 완료! 결과 파일을 다운로드하세요.'
                 : '분석 완료! 결과 파일을 다운로드하세요.';
      document.getElementById('downloadStat').textContent =
        `총 ${total}행 · 제안 ${suggested}개`;
      showToast('분석 완료! 파일을 다운로드하세요.', 'success');
    }
    document.getElementById('downloadSection').hidden = false;
  } catch (e) {
    showToast('파일 분석 오류: ' + e.message, 'error');
  } finally {
    processBtn.disabled = false;
    stopBtn.disabled    = true;
    stopRequested       = false;
    stopBtn.innerHTML   =
      `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg> 중단`;
  }
}

// ── 브랜드 관리 ───────────────────────────────────────────────────────
function renderBrandList(filter = '') {
  const brands   = StorageHelper.getBrands();
  const filtered = filter ? brands.filter(b => b.toLowerCase().includes(filter.toLowerCase())) : brands;
  document.getElementById('brandCount').textContent = `총 ${brands.length}개`;

  const list = document.getElementById('brandList');
  if (!filtered.length) { list.innerHTML = '<p class="brand-empty">브랜드가 없습니다.</p>'; return; }

  list.innerHTML = filtered.map(brand => {
    const idx = brands.indexOf(brand);
    return `<div class="brand-item">
      <span class="brand-name">${esc(brand)}</span>
      <button class="btn-delete-brand" data-index="${idx}" title="삭제">×</button>
    </div>`;
  }).join('');

  list.querySelectorAll('.btn-delete-brand').forEach(btn =>
    btn.addEventListener('click', () => {
      const b = StorageHelper.getBrands();
      b.splice(parseInt(btn.dataset.index), 1);
      StorageHelper.saveBrands(b);
      renderBrandList(document.getElementById('brandSearch').value);
      showToast('삭제됨', 'info');
    })
  );
}

function addBrand(name) {
  const t = name.trim();
  if (!t) return;
  const brands = StorageHelper.getBrands();
  if (brands.includes(t)) { showToast(`"${t}"은 이미 등록된 브랜드입니다.`, 'warning'); return; }
  brands.unshift(t);
  StorageHelper.saveBrands(brands);
  renderBrandList(document.getElementById('brandSearch').value);
  showToast(`"${t}" 추가됨`, 'success');
}

// ── 모달 ──────────────────────────────────────────────────────────────
const openModal  = id => { document.getElementById(id).classList.add('open'); document.body.style.overflow = 'hidden'; };
const closeModal = id => { document.getElementById(id).classList.remove('open'); document.body.style.overflow = ''; };

// ── 설정 ──────────────────────────────────────────────────────────────
function loadSettings() {
  const s = StorageHelper.getSettings();
  document.getElementById('openAiKeyInput').value    = s.openAiKey   || '';
  document.getElementById('openAiModelSelect').value = s.openAiModel || 'gpt-4o';
}

function saveSettings() {
  StorageHelper.saveSettings({
    openAiKey:   document.getElementById('openAiKeyInput').value.trim(),
    openAiModel: document.getElementById('openAiModelSelect').value,
  });
  showToast('설정 저장됨', 'success');
  closeModal('settingsModal');
}

// ── 탭 전환 ───────────────────────────────────────────────────────────
function switchTab(tabId) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabId));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === tabId + 'Tab'));
}

// ── 초기화 ────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {

  document.querySelectorAll('.tab').forEach(tab =>
    tab.addEventListener('click', () => switchTab(tab.dataset.tab)));

  document.getElementById('analyzeBtn').addEventListener('click', runDirectAnalysis);
  document.getElementById('keywordInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') runDirectAnalysis();
  });

  const dropZone = document.getElementById('dropZone');
  dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault(); dropZone.classList.remove('drag-over');
    if (e.dataTransfer.files[0]) handleFileSelect(e.dataTransfer.files[0]);
  });
  document.getElementById('fileSelectBtn').addEventListener('click',
    () => document.getElementById('fileInput').click());
  document.getElementById('fileInput').addEventListener('change', e => {
    if (e.target.files[0]) handleFileSelect(e.target.files[0]);
  });
  document.getElementById('removeFileBtn').addEventListener('click', () => {
    document.getElementById('fileInput').value = ''; resetFileState();
  });
  document.getElementById('processFileBtn').addEventListener('click', runFileAnalysis);
  document.getElementById('stopFileBtn').addEventListener('click', () => {
    stopRequested = true;
    document.getElementById('stopFileBtn').disabled = true;
    document.getElementById('stopFileBtn').textContent = '중단 중…';
  });

  document.getElementById('downloadXlsx').addEventListener('click', () => {
    if (resultWorkbook) downloadXlsx(resultWorkbook, `${originalFileName}_분석결과.xlsx`);
  });
  document.getElementById('downloadCsv').addEventListener('click', () => {
    if (resultWorkbook) downloadCsv(resultWorkbook, `${originalFileName}_분석결과.csv`);
  });

  document.getElementById('settingsBtn').addEventListener('click',          () => { loadSettings(); openModal('settingsModal'); });
  document.getElementById('settingsModalClose').addEventListener('click',   () => closeModal('settingsModal'));
  document.getElementById('settingsModalOverlay').addEventListener('click', () => closeModal('settingsModal'));
  document.getElementById('saveSettingsBtn').addEventListener('click', saveSettings);

  document.getElementById('brandManageBtn').addEventListener('click',       () => { renderBrandList(); openModal('brandModal'); });
  document.getElementById('brandModalClose').addEventListener('click',      () => closeModal('brandModal'));
  document.getElementById('brandModalOverlay').addEventListener('click',    () => closeModal('brandModal'));
  document.getElementById('brandInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') { addBrand(e.target.value); e.target.value = ''; }
  });
  document.getElementById('addBrandBtn').addEventListener('click', () => {
    const inp = document.getElementById('brandInput'); addBrand(inp.value); inp.value = '';
  });
  document.getElementById('brandSearch').addEventListener('input', e => renderBrandList(e.target.value));
  document.getElementById('clearBrandsBtn').addEventListener('click', () => {
    if (confirm('브랜드 목록을 모두 삭제하시겠습니까?')) { StorageHelper.saveBrands([]); renderBrandList(); }
  });

  document.getElementById('importBrandsBtn').addEventListener('click',  () => openModal('importModal'));
  document.getElementById('importModalClose').addEventListener('click', () => closeModal('importModal'));
  document.querySelector('#importModal .modal-overlay').addEventListener('click', () => closeModal('importModal'));
  document.getElementById('confirmImportBtn').addEventListener('click', () => {
    const text     = document.getElementById('importBrandsText').value;
    const mode     = document.querySelector('input[name="importMode"]:checked').value;
    const imported = text.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
    if (!imported.length) { showToast('가져올 브랜드가 없습니다.', 'warning'); return; }
    const existing = mode === 'replace' ? [] : StorageHelper.getBrands();
    StorageHelper.saveBrands([...new Set([...existing, ...imported])]);
    renderBrandList();
    closeModal('importModal');
    document.getElementById('importBrandsText').value = '';
    showToast(`${imported.length}개 브랜드 가져오기 완료`, 'success');
  });
});
