/**
 * Cloudflare Worker – Google 검색 맞춤법 교정 프록시
 *
 * 배포 방법:
 *   1. https://workers.cloudflare.com 에서 무료 계정 생성
 *   2. Create Application → Create Worker
 *   3. 이 파일 내용 전체를 붙여넣고 Deploy
 *   4. Worker URL을 앱 설정의 "Google Worker URL" 란에 입력
 *
 * 호출 형식:  GET https://<worker-url>?q=검색어
 * 응답 형식:  { "correction": "교정된 검색어" | null }
 */

export default {
  async fetch(request) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const { searchParams } = new URL(request.url);
    const q = searchParams.get('q');

    if (!q || !q.trim()) {
      return json({ correction: null, error: 'missing q' }, 400);
    }

    try {
      const googleUrl =
        'https://www.google.com/search' +
        `?q=${encodeURIComponent(q.trim())}&hl=ko&gl=KR&num=1`;

      const res = await fetch(googleUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
            'AppleWebKit/537.36 (KHTML, like Gecko) ' +
            'Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
          'Cache-Control': 'no-cache',
        },
        redirect: 'follow',
      });

      const html       = await res.text();
      const correction = extractCorrection(html, q.trim());

      return json({ correction });
    } catch (e) {
      return json({ correction: null, error: e.message });
    }
  },
};

// ── Google HTML에서 교정 검색어 추출 ─────────────────────────────────
function extractCorrection(html, original) {
  const candidates = [];

  // 패턴 1: "다음에 대한 검색 결과 표시 중" 뒤의 링크 텍스트
  const p1 = html.match(
    /다음에 대한 검색 결과 표시 중[\s\S]{0,80}?<(?:a|b)[^>]*>([\s\S]*?)<\/(?:a|b)>/
  );
  if (p1) candidates.push(strip(p1[1]));

  // 패턴 2: gL9Hy 클래스 (구글 UI 교정 링크)
  const p2 = html.match(/class="gL9Hy"[^>]*>([\s\S]*?)<\/a>/);
  if (p2) candidates.push(strip(p2[1]));

  // 패턴 3: class="spell" 링크
  const p3 = html.match(/class="spell"[^>]*>([\s\S]*?)<\/a>/);
  if (p3) candidates.push(strip(p3[1]));

  // 패턴 4: "Showing results for" (영문 페이지 혼재 대비)
  const p4 = html.match(/Showing results for[\s\S]{0,80}?<(?:a|b)[^>]*>([\s\S]*?)<\/(?:a|b)>/);
  if (p4) candidates.push(strip(p4[1]));

  for (const c of candidates) {
    if (c && c.toLowerCase() !== original.toLowerCase()) return c;
  }
  return null;
}

function strip(html) {
  return html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
