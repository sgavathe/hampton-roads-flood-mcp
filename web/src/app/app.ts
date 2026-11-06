import { DatePipe, DecimalPipe } from '@angular/common';
import { Component, computed, effect, inject, signal } from '@angular/core';
import {
  AreasResponse,
  AskResult,
  Comparison,
  Conditions,
  DepthClass,
  Exposure,
  FacilityCollection,
  FacilityDetails,
  FloodApiService,
  PublicConfig,
} from './flood-api.service';
import { DEPTH_COLORS, SceneViewComponent } from './scene-view';

export const CATEGORY_COLORS: Record<string, string> = {
  power: '#facc15',
  water: '#38bdf8',
  hospital: '#f472b6',
  fire_ems: '#fb923c',
  police: '#818cf8',
  school: '#a3e635',
  telecom: '#c084fc',
};

const PRESETS = [
  { level: 0, label: '0 m', sub: 'Baseline' },
  { level: 1, label: '+1 m', sub: 'Surge' },
  { level: 2, label: '+2 m', sub: 'Surge' },
  { level: 3, label: '+3 m', sub: 'Major surge' },
];
const COMPARE_LEVELS = [1, 2, 3];

@Component({
  selector: 'app-root',
  imports: [SceneViewComponent, DecimalPipe, DatePipe],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  private readonly api = inject(FloodApiService);

  protected readonly presets = PRESETS;
  protected readonly depthColors = DEPTH_COLORS;
  protected readonly categoryColors = CATEGORY_COLORS;
  protected readonly mcpUrl = `${location.origin}/mcp`;

  protected readonly config = signal<PublicConfig | null>(null);
  protected readonly meta = signal<AreasResponse | null>(null);
  protected readonly areaId = signal('norfolk');
  protected readonly level = signal(0);
  protected readonly facilities = signal<FacilityCollection | null>(null);
  protected readonly exposure = signal<Exposure | null>(null);
  protected readonly comparison = signal<Comparison | null>(null);
  protected readonly conditions = signal<Conditions | null>(null);
  protected readonly selected = signal<FacilityDetails | null>(null);
  protected readonly focus = signal<[number, number] | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly showFacilities = signal(true);
  protected readonly showBuildings = signal(true);
  protected readonly showWater = signal(true);
  protected readonly buildingsAvailable = signal<boolean | null>(null);
  protected readonly showMethod = signal(false);
  protected readonly panelsOpen = signal(true);
  protected readonly aiEnabled = signal(false);
  protected readonly question = signal('');
  protected readonly asking = signal(false);
  protected readonly askResult = signal<AskResult | null>(null);
  protected readonly askError = signal<string | null>(null);
  protected readonly suggestions = [
    'Which hospitals and substations in Norfolk are under water at +2 m?',
    'Compare Virginia Beach at 1, 2 and 3 meters.',
    'What is the lowest fire station in Williamsburg, and when does it flood?',
  ];

  protected readonly area = computed(() => this.meta()?.areas.find((a) => a.id === this.areaId()) ?? null);
  protected readonly categories = computed(() => this.meta()?.categories ?? []);
  protected readonly categoryLabel = computed(() => new Map(this.categories().map((c) => [c.id, c.label])));

  protected readonly depthById = computed(() => {
    const m = new Map<string, DepthClass>();
    for (const e of this.exposure()?.exposed ?? []) m.set(e.id, e.depthClass);
    return m;
  });

  /** Stacked-bar segments per comparison scenario, scaled to the area's facility count. */
  protected readonly compareRows = computed(() => {
    const c = this.comparison();
    if (!c) return [];
    const max = Math.max(1, ...c.scenarios.map((s) => s.exposed));
    return c.scenarios.map((s) => ({
      ...s,
      segments: this.categories()
        .map((cat) => ({ id: cat.id, value: s.byCategory[cat.id] ?? 0 }))
        .filter((seg) => seg.value > 0)
        .map((seg) => ({ ...seg, pct: (seg.value / max) * 100 })),
    }));
  });

  protected readonly topExposed = computed(() => (this.exposure()?.exposed ?? []).slice(0, 6));
  protected readonly tideHint = computed(() => {
    const t = this.conditions()?.tide;
    return t?.comparableToScenario ? t.waterLevelM : null;
  });

  private exposureTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    this.bootstrap();

    // Area change: facilities, comparison and live conditions.
    effect(() => {
      const id = this.areaId();
      if (!this.meta()?.ready) return;
      this.selected.set(null);
      this.api.facilities(id).then((fc) => this.facilities.set(fc), (e) => this.fail(e));
      this.api.compare(id, COMPARE_LEVELS).then((c) => this.comparison.set(c), (e) => this.fail(e));
      this.conditions.set(null);
      this.api.conditions(id).then(
        (c) => this.conditions.set(c),
        () => this.conditions.set({ weather: null, tide: null, note: '' }),
      );
    });

    // Area or level change: exposure (debounced for the slider).
    effect(() => {
      const id = this.areaId();
      const level = this.level();
      if (!this.meta()?.ready) return;
      clearTimeout(this.exposureTimer);
      this.exposureTimer = setTimeout(() => {
        this.api.exposure(id, level).then((x) => this.exposure.set(x), (e) => this.fail(e));
      }, 120);
    });
  }

  private async bootstrap() {
    try {
      const [config, meta, health] = await Promise.all([this.api.config(), this.api.areas(), this.api.health()]);
      this.config.set(config);
      this.meta.set(meta);
      this.aiEnabled.set(health.ai);
    } catch (e) {
      this.fail(e);
    }
  }

  private fail(e: unknown) {
    console.error(e);
    this.error.set('Could not reach the flood API.');
  }

  protected selectArea(id: string) {
    this.areaId.set(id);
    this.focus.set(null);
  }

  protected setLevel(value: number | string) {
    const n = Math.round(Number(value) * 10) / 10;
    if (Number.isFinite(n)) this.level.set(Math.min(5, Math.max(0, n)));
  }

  protected async openFacility(id: string, fly = false) {
    try {
      const d = await this.api.facility(id);
      this.selected.set(d);
      if (fly) this.focus.set([...d.coordinates]);
    } catch (e) {
      this.fail(e);
    }
  }

  protected async ask(text?: string) {
    const q = (text ?? this.question()).trim();
    if (!q || this.asking()) return;
    this.question.set(q);
    this.asking.set(true);
    this.askError.set(null);
    try {
      const r = await this.api.ask(q);
      this.askResult.set(r);
      // Drive the map from what the agent actually looked up.
      const a = r.mapAction;
      if (a?.area && a.area !== this.areaId()) this.selectArea(a.area);
      if (a?.waterLevelM !== null && a?.waterLevelM !== undefined) this.setLevel(a.waterLevelM);
      if (a?.facilityId) await this.openFacility(a.facilityId, true);
      else if (a?.focus) this.focus.set(a.focus);
    } catch (e) {
      this.askError.set((e as Error).message);
    } finally {
      this.asking.set(false);
    }
  }

  protected toolLabel(c: AskResult['toolCalls'][number]): string {
    const args = Object.values(c.args ?? {}).map((v) => (Array.isArray(v) ? `[${v.join(', ')}]` : String(v))).join(', ');
    return `${c.name}(${args})`;
  }

  protected depthOf(id: string): DepthClass {
    return this.depthById().get(id) ?? 'dry';
  }

  protected weatherIcon(summary: string | undefined): string {
    if (!summary) return '·';
    if (/thunder/i.test(summary)) return '⛈';
    if (/rain|drizzle|shower/i.test(summary)) return '🌧';
    if (/snow/i.test(summary)) return '❄';
    if (/fog/i.test(summary)) return '🌫';
    if (/overcast/i.test(summary)) return '☁';
    if (/partly/i.test(summary)) return '⛅';
    return '☀';
  }

  /** SVG ring dash for a percentage (circumference of r=26 is ~163.4). */
  protected ring(pct: number | null) {
    const c = 2 * Math.PI * 26;
    const v = Math.max(0, Math.min(100, pct ?? 0));
    return `${(v / 100) * c} ${c}`;
  }
}
