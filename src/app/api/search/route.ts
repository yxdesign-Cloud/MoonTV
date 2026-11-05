import { NextResponse } from 'next/server';

import { getAvailableApiSites, getCacheTime } from '@/lib/config';
import { searchFromApi } from '@/lib/downstream';
import { SearchResult } from '@/lib/types';

export const runtime = 'edge';

// 单源超时：慢源超过该时间直接降级丢弃，不再拖慢整体搜索
const SINGLE_SOURCE_TIMEOUT_MS = 4000;
// stale-while-revalidate：缓存过期后先回旧数据，后台静默刷新
const STALE_WHILE_REVALIDATE_SECONDS = 86400;

function buildCacheHeaders(cacheTime: number) {
  return {
    'Cache-Control': `public, max-age=${cacheTime}, s-maxage=${cacheTime}, stale-while-revalidate=${STALE_WHILE_REVALIDATE_SECONDS}`,
    'CDN-Cache-Control': `public, s-maxage=${cacheTime}, stale-while-revalidate=${STALE_WHILE_REVALIDATE_SECONDS}`,
    'Vercel-CDN-Cache-Control': `public, s-maxage=${cacheTime}, stale-while-revalidate=${STALE_WHILE_REVALIDATE_SECONDS}`,
  };
}

// 给单个源的搜索加超时，超时或异常均降级为空结果
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T
): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(fallback);
      }
    }, ms);

    promise.then(
      (value) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }
      },
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(fallback);
        }
      }
    );
  });
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q');
  const streamMode = searchParams.get('stream') === '1';

  if (!query) {
    const cacheTime = await getCacheTime();
    return NextResponse.json(
      { results: [] },
      {
        headers: buildCacheHeaders(cacheTime),
      }
    );
  }

  const apiSites = await getAvailableApiSites();

  // 渐进式渲染模式：每完成一个源就推送一行 NDJSON，前端先到先渲染
  if (streamMode) {
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      async start(controller) {
        const push = (payload: unknown) => {
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
          } catch (error) {
            // 前端已断开时忽略写入异常
          }
        };

        await Promise.all(
          apiSites.map(async (site) => {
            const results = await withTimeout<SearchResult[]>(
              searchFromApi(site, query),
              SINGLE_SOURCE_TIMEOUT_MS,
              []
            );
            push({ source: site.key, results });
          })
        );

        push({ done: true });
        try {
          controller.close();
        } catch (error) {
          // 已关闭时忽略
        }
      },
    });

    return new Response(body, {
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    });
  }

  const searchPromises = apiSites.map((site) =>
    withTimeout<SearchResult[]>(
      searchFromApi(site, query),
      SINGLE_SOURCE_TIMEOUT_MS,
      []
    )
  );

  try {
    const results = await Promise.all(searchPromises);
    const flattenedResults = results.flat();
    const cacheTime = await getCacheTime();

    return NextResponse.json(
      { results: flattenedResults },
      {
        headers: buildCacheHeaders(cacheTime),
      }
    );
  } catch (error) {
    return NextResponse.json({ error: '搜索失败' }, { status: 500 });
  }
}
