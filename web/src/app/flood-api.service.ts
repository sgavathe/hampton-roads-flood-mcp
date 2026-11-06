import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export type DepthClass = 'dry' | 'shallow' | 'deep';

export interface Area {
  id: string;
  name: string;
  subtitle: string;
  bbox: [number, number, number, number];
  camera: { position: [number, number, number]; heading: number; tilt: number };
  tideStation: { id: string; name: string };
  facilities: number;
}

export interface Category {
  id: string;
  label: string;
  description: string;
}

export interface AreasResponse {
  ready: boolean;
  datum: string;
  areas: Area[];
  categories: Category[];
  manifest: { generatedAt: string; sources: { facilities: string; elevation: Record<string, number> } } | null;
}

export interface FacilityProps {
  id: string;
  name: string;
  category: string;
  area: string;
  elevationM: number;
  elevationSource: string;
  osmUrl: string;
  operator: string | null;
}

export interface FacilityCollection {
  type: 'FeatureCollection';
  features: { type: 'Feature'; id: string; geometry: { type: 'Point'; coordinates: [number, number] }; properties: FacilityProps }[];
}

export interface ExposedFacility {
  id: string;
  name: string;
  category: string;
  elevationM: number;
  depthM: number;
  depthClass: DepthClass;
  coordinates: [number, number];
}

export interface Exposure {
  area: { id: string; name: string };
  waterLevelM: number;
  datum: string;
  totals: { facilities: number; exposed: number; deep: number };
  byCategory: { id: string; label: string; total: number; exposed: number; deep: number }[];
  landFloodedPct: number | null;
  landSamples: number;
  exposed: ExposedFacility[];
  exposedTruncated: boolean;
}

export interface Comparison {
  area: string;
  facilities: number;
  scenarios: { waterLevelM: number; exposed: number; deep: number; landFloodedPct: number | null; byCategory: Record<string, number> }[];
}

export interface FacilityDetails extends FacilityProps {
  coordinates: [number, number];
  floodsAtLevelM: number;
  scenarios: { waterLevelM: number; depthM: number | null; status: DepthClass }[];
}

export interface Conditions {
  weather: {
    tempF: number; feelsLikeF: number; humidityPct: number; precipIn: number; windMph: number; windDir: string | null;
    summary: string; observedAt: string;
    daily: { date: string; summary: string; code: number; highF: number; lowF: number; precipChancePct: number }[];
  } | null;
  tide: { station: string; waterLevelM: number; datum: string; comparableToScenario: boolean; observedAt: string } | null;
  note: string;
}

export interface AskResult {
  answer: string;
  toolCalls: { name: string; args: Record<string, unknown>; isError: boolean }[];
  mapAction: {
    area: string | null;
    waterLevelM: number | null;
    focus: [number, number] | null;
    facilityId?: string;
    highlightIds?: string[];
  } | null;
  model: string;
  tokens: number;
  latencyMs: number;
}

export interface Health {
  status: string;
  dataReady: boolean;
  mcp: boolean;
  ai: boolean;
}

export interface PublicConfig {
  arcgisApiKey: string | null;
  buildingsLayerUrl: string;
}

@Injectable({ providedIn: 'root' })
export class FloodApiService {
  private readonly http = inject(HttpClient);
  private get<T>(url: string, params?: Record<string, string | number>) {
    return firstValueFrom(this.http.get<T>(url, { params }));
  }

  config = () => this.get<PublicConfig>('/api/config');
  areas = () => this.get<AreasResponse>('/api/areas');
  facilities = (area: string) => this.get<FacilityCollection>(`/api/areas/${area}/facilities`);
  exposure = (area: string, level: number) => this.get<Exposure>('/api/exposure', { area, level });
  compare = (area: string, levels: number[]) => this.get<Comparison>('/api/compare', { area, levels: levels.join(',') });
  facility = (id: string) => this.get<FacilityDetails>('/api/facility', { id });
  conditions = (area: string) => this.get<Conditions>('/api/conditions', { area });
  health = () => this.get<Health>('/api/health');

  async ask(question: string): Promise<AskResult> {
    try {
      return await firstValueFrom(this.http.post<AskResult>('/api/ask', { question }));
    } catch (err) {
      const msg = err instanceof HttpErrorResponse ? err.error?.error ?? `Request failed (${err.status}).` : 'Request failed.';
      throw new Error(msg);
    }
  }
}
