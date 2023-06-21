import { FetchError } from "ofetch";

import { formatJWMeta, mediaTypeToJW } from "./justwatch";
import {
  TMDBMediaToMediaType,
  formatTMDBMeta,
  getEpisodes,
  getExternalIds,
  getMediaDetails,
  mediaTypeToTMDB,
} from "./tmdb";
import {
  JWMediaResult,
  JWSeasonMetaResult,
  JW_API_BASE,
  MWMediaMeta,
  MWMediaType,
  TMDBMediaResult,
  TMDBMovieData,
  TMDBSeasonMetaResult,
  TMDBShowData,
} from "./types";
import { makeUrl, proxiedFetch } from "../helpers/fetch";

type JWExternalIdType =
  | "eidr"
  | "imdb_latest"
  | "imdb"
  | "tmdb_latest"
  | "tmdb"
  | "tms";

interface JWExternalId {
  provider: JWExternalIdType;
  external_id: string;
}

interface JWDetailedMeta extends JWMediaResult {
  external_ids: JWExternalId[];
}

export interface DetailedMeta {
  meta: MWMediaMeta;
  imdbId?: string;
  tmdbId?: string;
}

export function formatTMDBMetaResult(
  details: TMDBShowData | TMDBMovieData,
  type: MWMediaType
): TMDBMediaResult {
  if (type === MWMediaType.MOVIE) {
    const movie = details as TMDBMovieData;
    return {
      id: details.id,
      title: movie.title,
      object_type: mediaTypeToTMDB(type),
      poster: movie.poster_path ?? undefined,
      original_release_year: new Date(movie.release_date).getFullYear(),
    };
  }
  if (type === MWMediaType.SERIES) {
    const show = details as TMDBShowData;
    return {
      id: details.id,
      title: show.name,
      object_type: mediaTypeToTMDB(type),
      seasons: show.seasons.map((v) => ({
        id: v.id,
        season_number: v.season_number,
        title: v.name,
      })),
      poster: (details as TMDBMovieData).poster_path ?? undefined,
      original_release_year: new Date(show.first_air_date).getFullYear(),
    };
  }

  throw new Error("unsupported type");
}

export async function getMetaFromId(
  type: MWMediaType,
  id: string,
  seasonId?: string
): Promise<DetailedMeta | null> {
  const details = await getMediaDetails(id, mediaTypeToTMDB(type));

  if (!details) return null;

  const externalIds = await getExternalIds(id, mediaTypeToTMDB(type));
  const imdbId = externalIds.imdb_id ?? undefined;

  let seasonData: TMDBSeasonMetaResult | undefined;

  if (type === MWMediaType.SERIES) {
    const seasons = (details as TMDBShowData).seasons;
    const season =
      seasons?.find((v) => v.id.toString() === seasonId) ?? seasons?.[0];

    const episodes = await getEpisodes(
      details.id.toString(),
      season.season_number === null || season.season_number === 0
        ? 1
        : season.season_number
    );

    if (season && episodes) {
      seasonData = {
        id: season.id.toString(),
        season_number:
          season.season_number === null || season.season_number === 0
            ? 1
            : season.season_number,
        title: season.name,
        episodes,
      };
    }
  }

  const tmdbmeta = formatTMDBMetaResult(details, type);
  if (!tmdbmeta) return null;
  const meta = formatTMDBMeta(tmdbmeta, seasonData);
  if (!meta) return null;

  return {
    meta,
    imdbId,
    tmdbId: id,
  };
}

export async function getLegacyMetaFromId(
  type: MWMediaType,
  id: string,
  seasonId?: string
): Promise<DetailedMeta | null> {
  const queryType = mediaTypeToJW(type);

  let data: JWDetailedMeta;
  try {
    const url = makeUrl("/content/titles/{type}/{id}/locale/en_US", {
      type: queryType,
      id,
    });
    data = await proxiedFetch<JWDetailedMeta>(url, { baseURL: JW_API_BASE });
  } catch (err) {
    if (err instanceof FetchError) {
      // 400 and 404 are treated as not found
      if (err.statusCode === 400 || err.statusCode === 404) return null;
    }
    throw err;
  }

  let imdbId = data.external_ids.find(
    (v) => v.provider === "imdb_latest"
  )?.external_id;
  if (!imdbId)
    imdbId = data.external_ids.find((v) => v.provider === "imdb")?.external_id;

  let tmdbId = data.external_ids.find(
    (v) => v.provider === "tmdb_latest"
  )?.external_id;
  if (!tmdbId)
    tmdbId = data.external_ids.find((v) => v.provider === "tmdb")?.external_id;

  let seasonData: JWSeasonMetaResult | undefined;
  if (data.object_type === "show") {
    const seasonToScrape = seasonId ?? data.seasons?.[0].id.toString() ?? "";
    const url = makeUrl("/content/titles/show_season/{id}/locale/en_US", {
      id: seasonToScrape,
    });
    seasonData = await proxiedFetch<any>(url, { baseURL: JW_API_BASE });
  }

  return {
    meta: formatJWMeta(data, seasonData),
    imdbId,
    tmdbId,
  };
}

export function TMDBMediaToId(media: MWMediaMeta): string {
  return ["tmdb", mediaTypeToTMDB(media.type), media.id].join("-");
}

export function decodeTMDBId(
  paramId: string
): { id: string; type: MWMediaType } | null {
  const [prefix, type, id] = paramId.split("-", 3);
  if (prefix !== "tmdb") return null;
  let mediaType;
  try {
    mediaType = TMDBMediaToMediaType(type);
  } catch {
    return null;
  }
  return {
    type: mediaType,
    id,
  };
}

export async function convertLegacyUrl(
  url: string
): Promise<string | undefined> {
  if (url.startsWith("/media/JW")) {
    const urlParts = url.split("/").slice(2);
    const [, type, id] = urlParts[0].split("-", 3);
    const meta = await getLegacyMetaFromId(TMDBMediaToMediaType(type), id);
    if (!meta) return undefined;
    const tmdbId = meta.tmdbId;
    if (!tmdbId) return undefined;
    return `/media/tmdb-${type}-${tmdbId}`;
  }
  return undefined;
}
