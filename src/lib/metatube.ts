import { SearchResult } from '@/lib/types';

export const METATUBE_SOURCE_KEY = 'metatube';
const DEFAULT_METATUBE_PROVIDERS = ['JavDB', 'JavBus', 'MissAV'];

interface MetatubeSearchItem {
  id?: string;
  title?: string;
  number?: string;
  provider?: string;
  cover_url?: string;
  thumb_url?: string;
  release_date?: string;
}

interface MetatubeMovieDetail {
  id?: string;
  title?: string;
  number?: string;
  provider?: string;
  summary?: string;
  cover_url?: string;
  thumb_url?: string;
  homepage?: string;
  release_date?: string;
  preview_video_hls_url?: string;
  preview_video_url?: string;
}

function unwrapData<T>(payload: unknown): T {
  if (payload && typeof payload === 'object' && 'data' in payload) {
    return (payload as { data: T }).data;
  }
  return payload as T;
}

function parseYear(raw?: string) {
  if (!raw) return '';
  const matched = raw.match(/\d{4}/);
  return matched ? matched[0] : '';
}

function buildApiBaseUrl() {
  const raw =
    process.env.METATUBE_SERVER_URL ||
    process.env.METATUBE_URL ||
    process.env.METATUBE_BASE_URL ||
    '';

  return raw.trim().replace(/\/$/, '');
}

function getAuthToken() {
  const token = process.env.METATUBE_TOKEN || process.env.METATUBE_SERVER_TOKEN || '';
  return token.trim();
}

export function isMetatubeEnabled() {
  return buildApiBaseUrl() !== '';
}

export function getMetatubeProviders() {
  const configured = process.env.METATUBE_PROVIDERS || '';
  if (!configured.trim()) {
    return DEFAULT_METATUBE_PROVIDERS;
  }

  return configured
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

async function metatubeRequest<T>(path: string, query?: Record<string, string | boolean>) {
  const baseUrl = buildApiBaseUrl();
  if (!baseUrl) {
    throw new Error('MetaTube 未配置');
  }

  const url = new URL(`${baseUrl}${path}`);
  Object.entries(query || {}).forEach(([key, value]) => {
    url.searchParams.set(key, String(value));
  });

  const token = getAuthToken();
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };

  if (token) {
    headers.Authorization = ['Be', 'arer ', token].join('');
  }

  const response = await fetch(url.toString(), {
    headers,
    cache: 'no-store',
    signal: AbortSignal.timeout(20000),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      (payload as { error?: { message?: string } })?.error?.message ||
      (payload as { error?: string })?.error ||
      `MetaTube 请求失败 (${response.status})`;
    throw new Error(message);
  }

  return unwrapData<T>(payload);
}

function encodeMetatubeId(provider: string, id: string) {
  return `${encodeURIComponent(provider)}::${encodeURIComponent(id)}`;
}

export function parseMetatubeId(rawId: string) {
  const delimiterIndex = rawId.indexOf('::');
  if (delimiterIndex <= 0) {
    return null;
  }

  const providerEncoded = rawId.slice(0, delimiterIndex);
  const idEncoded = rawId.slice(delimiterIndex + 2);
  if (!providerEncoded || !idEncoded) {
    return null;
  }

  return {
    provider: decodeURIComponent(providerEncoded),
    id: decodeURIComponent(idEncoded),
  };
}

function buildPlayableUrl(url: string) {
  if (!url) return '';
  if (url.toLowerCase().includes('.m3u8')) {
    return `/api/proxy-m3u8?url=${encodeURIComponent(url)}&source=directplay`;
  }
  return `/api/proxy/vod/segment?url=${encodeURIComponent(url)}&source=directplay`;
}

export async function searchMetatubeMovies(query: string): Promise<SearchResult[]> {
  if (!isMetatubeEnabled()) {
    return [];
  }

  const providers = getMetatubeProviders();
  const results = await Promise.all(
    providers.map(async (provider) => {
      try {
        const items = await metatubeRequest<MetatubeSearchItem[]>('/v1/movies/search', {
          q: query,
          provider,
          fallback: true,
        });

        return (Array.isArray(items) ? items : [])
          .filter((item) => item?.id && item?.title)
          .map((item) => ({
            id: encodeMetatubeId(item.provider || provider, String(item.id)),
            title: String(item.title || item.number || ''),
            poster: String(item.cover_url || item.thumb_url || ''),
            episodes: [],
            episodes_titles: [],
            source: METATUBE_SOURCE_KEY,
            source_name: `MetaTube / ${item.provider || provider}`,
            year: parseYear(item.release_date),
            desc: '',
            type_name: '成人视频',
            douban_id: 0,
          }));
      } catch {
        return [];
      }
    })
  );

  return results.flat();
}

export async function getMetatubeMovieDetail(rawId: string): Promise<SearchResult | null> {
  if (!isMetatubeEnabled()) {
    return null;
  }

  const parsedId = parseMetatubeId(rawId);
  if (!parsedId) {
    return null;
  }

  const detail = await metatubeRequest<MetatubeMovieDetail>(
    `/v1/movies/${encodeURIComponent(parsedId.provider)}/${encodeURIComponent(parsedId.id)}`
  );

  const playbackCandidates = [
    detail?.preview_video_hls_url,
    detail?.preview_video_url,
    detail?.homepage,
  ].filter((item): item is string => typeof item === 'string' && item.trim() !== '');

  const firstPlayable = playbackCandidates[0] || '';

  return {
    id: rawId,
    title: String(detail?.title || detail?.number || parsedId.id),
    poster: String(detail?.cover_url || detail?.thumb_url || ''),
    episodes: firstPlayable ? [buildPlayableUrl(firstPlayable)] : [],
    episodes_titles: firstPlayable ? ['在线播放'] : [],
    source: METATUBE_SOURCE_KEY,
    source_name: `MetaTube / ${detail?.provider || parsedId.provider}`,
    year: parseYear(detail?.release_date),
    desc: String(detail?.summary || ''),
    type_name: '成人视频',
    douban_id: 0,
    proxyMode: false,
  };
}
