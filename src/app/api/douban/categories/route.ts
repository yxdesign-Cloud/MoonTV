import { NextResponse } from 'next/server';

import { getCacheTime } from '@/lib/config';
import { DoubanItem, DoubanResult } from '@/lib/types';

interface DoubanCategoryApiResponse {
  total: number;
  items: Array<{
    id: string;
    title: string;
    card_subtitle: string;
    pic: {
      large: string;
      normal: string;
    };
    rating: {
      value: number;
    };
  }>;
}

// 上游豆瓣接口在境外访问时经常超过 10s，旧实现在 abort 后直接返回 500，
// 用户要白等 10–15s 且失败结果不缓存，「最新」「美剧」「国产剧」等分类每次访问都失败。
// 这里改为：更短的超时 + 上一次成功结果兜底 + 失败也返回可短缓存的 200 响应。
const UPSTREAM_TIMEOUT_MS = 4000;
const DEGRADED_TTL_SECONDS = 60;
const EMPTY_TTL_SECONDS = 20;

// Edge Runtime 实例内保留各分类最近一次成功结果，供上游超时时兜底
const lastGoodResults = new Map<
  string,
  { list: DoubanItem[]; savedAt: number }
>();
const LAST_GOOD_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const LAST_GOOD_MAX_ENTRIES = 60;

function rememberGoodResults(key: string, list: DoubanItem[]) {
  if (list.length === 0) {
    return;
  }
  lastGoodResults.set(key, { list, savedAt: Date.now() });
  if (lastGoodResults.size > LAST_GOOD_MAX_ENTRIES) {
    const oldestKey = lastGoodResults.keys().next().value;
    if (typeof oldestKey === 'string') {
      lastGoodResults.delete(oldestKey);
    }
  }
}

function readGoodResults(key: string): DoubanItem[] {
  const entry = lastGoodResults.get(key);
  if (!entry) {
    return [];
  }
  if (Date.now() - entry.savedAt > LAST_GOOD_MAX_AGE_MS) {
    lastGoodResults.delete(key);
    return [];
  }
  return entry.list;
}

function buildCacheHeaders(cacheTime: number) {
  return {
    'Cache-Control': `public, max-age=${cacheTime}, s-maxage=${cacheTime}, stale-while-revalidate=86400`,
    'CDN-Cache-Control': `public, s-maxage=${cacheTime}, stale-while-revalidate=86400`,
    'Vercel-CDN-Cache-Control': `public, s-maxage=${cacheTime}, stale-while-revalidate=86400`,
  };
}

async function fetchDoubanData(
  url: string
): Promise<DoubanCategoryApiResponse> {
  // 添加超时控制
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  // 设置请求选项，包括信号和头部
  const fetchOptions = {
    signal: controller.signal,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      Referer: 'https://movie.douban.com/',
      Accept: 'application/json, text/plain, */*',
      Origin: 'https://movie.douban.com',
    },
  };

  try {
    // 尝试直接访问豆瓣API
    const response = await fetch(url, fetchOptions);
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

export const runtime = 'edge';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  // 获取参数
  const kind = searchParams.get('kind') || 'movie';
  const category = searchParams.get('category');
  const type = searchParams.get('type');
  const pageLimit = parseInt(searchParams.get('limit') || '20');
  const pageStart = parseInt(searchParams.get('start') || '0');

  // 验证参数
  if (!kind || !category || !type) {
    return NextResponse.json(
      { error: '缺少必要参数: kind 或 category 或 type' },
      { status: 400 }
    );
  }

  if (!['tv', 'movie'].includes(kind)) {
    return NextResponse.json(
      { error: 'kind 参数必须是 tv 或 movie' },
      { status: 400 }
    );
  }

  if (pageLimit < 1 || pageLimit > 100) {
    return NextResponse.json(
      { error: 'pageSize 必须在 1-100 之间' },
      { status: 400 }
    );
  }

  if (pageStart < 0) {
    return NextResponse.json(
      { error: 'pageStart 不能小于 0' },
      { status: 400 }
    );
  }

  const target = `https://m.douban.com/rexxar/api/v2/subject/recent_hot/${kind}?start=${pageStart}&limit=${pageLimit}&category=${category}&type=${type}`;
  const fallbackKey = `${kind}|${category}|${type}|${pageStart}|${pageLimit}`;

  try {
    // 调用豆瓣 API
    const doubanData = await fetchDoubanData(target);

    // 转换数据格式
    const list: DoubanItem[] = doubanData.items.map((item) => ({
      id: item.id,
      title: item.title,
      poster: item.pic?.normal || item.pic?.large || '',
      rate: item.rating?.value ? item.rating.value.toFixed(1) : '',
      year: item.card_subtitle?.match(/(\d{4})/)?.[1] || '',
    }));

    rememberGoodResults(fallbackKey, list);

    const response: DoubanResult = {
      code: 200,
      message: '获取成功',
      list: list,
    };

    const cacheTime = await getCacheTime();
    return NextResponse.json(response, {
      headers: buildCacheHeaders(cacheTime),
    });
  } catch (error) {
    // 上游超时或报错时不再抛 500：优先用实例内上一次成功结果兜底，
    // 没有兜底数据则返回空列表，并只做很短时间的缓存，避免把空结果长期固化。
    const fallbackList = readGoodResults(fallbackKey);
    const degraded: DoubanResult = {
      code: 200,
      message: fallbackList.length > 0 ? '获取成功（暂用上次数据）' : '暂无数据',
      list: fallbackList,
    };
    const degradedTtl =
      fallbackList.length > 0 ? DEGRADED_TTL_SECONDS : EMPTY_TTL_SECONDS;

    return NextResponse.json(degraded, {
      status: 200,
      headers: {
        ...buildCacheHeaders(degradedTtl),
        'X-Douban-Degraded': fallbackList.length > 0 ? 'stale' : 'empty',
        'X-Douban-Error': String((error as Error).message).slice(0, 120),
      },
    });
  }
}
