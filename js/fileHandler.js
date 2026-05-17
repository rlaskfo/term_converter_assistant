/* =====================================================================
   fileHandler.js  –  Excel / CSV 읽기·쓰기 (SheetJS)
   헤더: 4번째 행(0-index = 3), "검색어" 컬럼 → "제안 검색어" 컬럼 추가
   ===================================================================== */

const HEADER_ROW_INDEX = 3;
const KEYWORD_COL      = '검색어';
const RESULT_COL       = '제안 검색어';
const REASON_COL       = '사유';

// ── 파일 파싱 ─────────────────────────────────────────────────────────
function parseFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (e) => {
      try {
        const wb  = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
        const ws  = wb.Sheets[wb.SheetNames[0]];
        const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

        if (raw.length <= HEADER_ROW_INDEX) {
          return reject(new Error('파일에 데이터가 부족합니다 (4번째 행 헤더 필요).'));
        }

        const headerRow = raw[HEADER_ROW_INDEX];
        const kwColIdx  = headerRow.findIndex(h => String(h).trim() === KEYWORD_COL);

        if (kwColIdx === -1) {
          return reject(new Error(
            `"${KEYWORD_COL}" 컬럼을 찾을 수 없습니다.\n` +
            `4번째 행 헤더: ${headerRow.filter(Boolean).join(', ')}`
          ));
        }

        const rows = raw.slice(HEADER_ROW_INDEX + 1).map((row, i) => ({
          rowIndex: HEADER_ROW_INDEX + 1 + i,
          keyword:  String(row[kwColIdx] ?? '').trim(),
          rawRow:   row,
        }));

        resolve({ raw, headerRow, kwColIdx, rows });
      } catch (err) {
        reject(new Error('파일 파싱 실패: ' + err.message));
      }
    };

    reader.onerror = () => reject(new Error('파일 읽기 실패'));
    reader.readAsArrayBuffer(file);
  });
}

// ── 결과 병합 → WorkBook 생성 ──────────────────────────────────────────
function buildResultWorkbook(parsed, results) {
  const { raw, headerRow } = parsed;

  // 제안 검색어 컬럼 위치
  let resultColIdx = headerRow.findIndex(h => String(h).trim() === RESULT_COL);
  if (resultColIdx === -1) resultColIdx = headerRow.length;

  // 사유 컬럼은 제안 검색어 바로 다음
  const reasonColIdx = resultColIdx + 1;

  const output = raw.map(row => [...row]);
  output[HEADER_ROW_INDEX][resultColIdx] = RESULT_COL;
  output[HEADER_ROW_INDEX][reasonColIdx] = REASON_COL;

  results.forEach(({ rowIndex, output: value, reason }) => {
    if (!output[rowIndex]) return;
    // 제안 검색어: 실제 교정 결과만 (없으면 빈 값)
    output[rowIndex][resultColIdx] = value || '';
    // 사유: 건너뛴 이유 (없으면 빈 값)
    output[rowIndex][reasonColIdx] = reason || '';
  });

  const ws = XLSX.utils.aoa_to_sheet(output);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return wb;
}

// ── XLSX 다운로드 ──────────────────────────────────────────────────────
function downloadXlsx(workbook, filename = '검색어분석결과.xlsx') {
  XLSX.writeFile(workbook, filename);
}

// ── CSV 다운로드 (BOM 포함) ────────────────────────────────────────────
function downloadCsv(workbook, filename = '검색어분석결과.csv') {
  const csv  = XLSX.utils.sheet_to_csv(workbook.Sheets[workbook.SheetNames[0]]);
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── 일괄 분석 (진행률 콜백, 중단 콜백, 시작 인덱스) ─────────────────
async function processRows(rows, options, onProgress, isCancelled, startFrom = 0) {
  const results = [];
  let stopped = false;

  for (let i = startFrom; i < rows.length; i++) {
    // 중단 요청 확인
    if (isCancelled && isCancelled()) {
      stopped = true;
      break;
    }

    const { rowIndex, keyword } = rows[i];
    let output = '';
    let reason = '';

    if (keyword) {
      try {
        const result = await analyzeKeyword(keyword, options);
        // 건너뛴 경우: 제안 검색어 비우고 사유 기록
        if (result.skipped) {
          reason = result.reason || '';
        } else {
          output = result.output || '';   // "|" 구분 교정어, 없으면 빈 값
        }
      } catch (e) {
        console.warn(`[Row ${rowIndex}] 분석 오류:`, e.message);
      }
    }

    results.push({ rowIndex, keyword, output, reason });
    // 진행률은 이번 루프에서 처리한 개수만 넘김 (app.js에서 alreadyDone 더함)
    if (onProgress) onProgress(results.length, rows.length);

    // OpenAI API rate-limit 방지 (중단 요청이 없을 때만 대기)
    if (options.enableOpenAI && options.openAiKey && i < rows.length - 1) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  return { results, stopped };
}
