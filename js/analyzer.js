/* =====================================================================
   analyzer.js  –  OpenAI Responses API + Web Search 단계별 분석

   실행 순서:
     1. 건너뛰기 판단  (규칙 기반 — 25자↑, 운영/플랫폼/모델번호)
     2. OpenAI 호출   (web_search_preview 도구 사용)
        ① 구성 요소 분류  (브랜드 / 카테고리 / 속성)
        ② 오타 체크      → 오타 있으면 교정 후 종료
        ③ 띄어쓰기 체크  → 오타 없을 때만
        ④ 유의어 확장    → 오타 없을 때만, 최대 3개
        → "|" 구분 결과 반환
   ===================================================================== */

// ── 건너뛰기 판단 ──────────────────────────────────────────────────────
function shouldSkip(keyword) {
  const trimmed = keyword.trim();
  if (!trimmed) return { skip: true, reason: '빈 값' };
  if (trimmed.length >= 25) return { skip: true, reason: '25자 이상' };

  const lower = trimmed.toLowerCase();
  if (SKIP_OPERATIONAL.some(kw => lower.includes(kw)))
    return { skip: true, reason: '운영/고객응대 키워드' };
  if (SKIP_PLATFORMS.some(kw => lower.includes(kw.toLowerCase())))
    return { skip: true, reason: '플랫폼/방송 키워드' };
  if (!/[가-힣]/.test(trimmed) && /[A-Za-z]/.test(trimmed) && /\d/.test(trimmed))
    return { skip: true, reason: '모델명 추정 (영문+숫자 코드)' };

  return { skip: false };
}

// ── OpenAI Responses API 호출 ─────────────────────────────────────────
async function callOpenAI(keyword, apiKey, model) {
  if (!apiKey || !keyword) return null;

  const brandList = StorageHelper.getBrands().slice(0, 80).join(', ');
  const modelId   = model || 'gpt-4o';
  const endpoint  = 'https://api.openai.com/v1/responses';

  const instructions = `당신은 한국 이커머스 검색어 분석 전문가입니다.
웹 검색을 활용해 아래 4단계를 반드시 순서대로 실행하세요.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【단계 1】 구성 요소 분류
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
검색어를 세 가지 유형으로 분류하세요.
- 브랜드: 브랜드명 (예: 나이키, 구찌, 뉴발란스)
- 카테고리: 상품 종류 (예: 청바지, 티셔츠, 운동화)
- 속성: 색상·성별·사이즈·핏 등 (예: 남성, 블랙, 슬림핏)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【단계 2】 오타 체크 — 키보드 타이핑 오류
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
각 구성 요소의 키보드 인접 키 오타를 웹 검색으로 확인하세요.
- 오타 판단 기준: 한 두 글자가 인접 키로 잘못 입력된 경우
  (예: "냠성"→"남성" / "앋다스"→"아디다스" / "뉴밬란스"→"뉴발란스")
- 동음이의·방언·줄임말은 오타가 아님

▶ 오타 발견 → 교정된 검색어 1개만 반환하고 즉시 종료 (3·4단계 생략)
▶ 오타 없음 → 단계 3으로 진행

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【단계 3】 띄어쓰기 오류 체크 (오타 없을 때만)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
단어가 붙어 있거나 잘못 분리된 경우 교정하세요.
- 예: "남성청바지"→"남성 청바지" / "나이 키운동화"→"나이키 운동화"
- 교정이 없으면 원본 유지

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【단계 4】 유의어/동의어 확장 (오타 없을 때만, 최대 3개)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
교정된 검색어 기준으로 실제 쇼핑 검색에 쓰이는 유의어·동의어를 추가하세요.
- 예: "청바지" → "진", "데님 팬츠" / "운동화" → "스니커즈"
- 의미가 다르거나 상위/하위 개념은 제외

【브랜드 참고 목록】
${brandList}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【최종 응답 형식 — 반드시 준수】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- 오타 교정 시 (단계 2에서 종료): 교정어 1개만 반환
  예) 남성 청바지
- 오타 없을 때 (단계 3·4 실행): 교정어|유의어1|유의어2 형식
  예) 남성 청바지|남성 진|남성 데님 팬츠
- 변경 없고 유의어도 없으면: SKIP
- 따옴표·설명 없이 결과 한 줄만 출력`;

  try {
    const res = await fetch(endpoint, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model:        modelId,
        tools:        [{ type: 'web_search_preview' }],
        instructions,
        input:        `검색어: "${keyword}"`,
        temperature:  0,
        max_output_tokens: 200,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.warn('[OpenAI] HTTP 오류:', res.status, err?.error?.message);
      return null;
    }

    const data = await res.json();

    // Responses API 응답 구조: output 배열에서 message 타입 찾기
    const text = data?.output
      ?.find(o => o.type === 'message')
      ?.content?.find(c => c.type === 'output_text')
      ?.text?.trim();

    if (!text || text.toUpperCase() === 'SKIP') return null;

    const clean = text.replace(/^["'「」『』`\s]+|["'「」『』`\s]+$/g, '').trim();
    if (!clean) return null;

    // 파이프 구분 파싱 + 부연 설명 제거
    const parts = clean.split('|').map(s => {
      return s
        .split('\n')[0]                                          // 첫 줄만
        .replace(/\s*[\(\[（【][^)\]）】]*[\)\]）】]/g, '')      // (괄호 설명) 제거
        .replace(/\s*[-–—].*$/,  '')                            // - 이후 설명 제거
        .replace(/^["'「」『』`\s]+|["'「」『』`\s]+$/g, '')    // 따옴표 제거
        .trim();
    }).filter(Boolean);

    // 첫 항목이 원본과 동일하고 추가 항목 없으면 의미 없음
    if (parts.length === 1 && parts[0].toLowerCase() === keyword.toLowerCase()) return null;

    // 항목 1개 = 오타 교정, 2개 이상 = 유의어 확장
    return { parts, isTypoFix: parts.length === 1 };
  } catch (e) {
    console.warn('[OpenAI] 호출 실패:', e.message);
    return null;
  }
}

// ── 메인 분석 함수 ─────────────────────────────────────────────────────
async function analyzeKeyword(keyword, options = {}) {
  const {
    enableOpenAI = true,
    openAiKey    = '',
    openAiModel  = 'gpt-4o',
  } = options;

  const trimmed = keyword.trim();
  if (!trimmed) return { original: keyword, skipped: true, reason: '빈 값', output: '' };

  const skipResult = shouldSkip(trimmed);
  if (skipResult.skip)
    return { original: keyword, skipped: true, reason: skipResult.reason, output: '' };

  let aiResult = '-';
  let aiNote   = '';      // '오타 교정' or '띄어쓰기·유의어' or ''
  let suggestions = [];

  if (enableOpenAI && openAiKey) {
    const res = await callOpenAI(trimmed, openAiKey, openAiModel);
    if (res && res.parts.length) {
      suggestions = res.parts;
      aiResult    = res.parts.join(' | ');
      aiNote      = res.isTypoFix ? '오타 교정' : '띄어쓰기·유의어';
    }
  } else if (!enableOpenAI) {
    aiResult = '비활성';
  } else {
    aiResult = 'API 키 없음';
  }

  return {
    original:    keyword,
    skipped:     false,
    suggestions,
    output:      suggestions.join('|'),
    aiResult,
    aiNote,
  };
}
