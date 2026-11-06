import {
  Component,
  ElementRef,
  OnDestroy,
  effect,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import type SceneView from '@arcgis/core/views/SceneView.js';
import type GraphicsLayer from '@arcgis/core/layers/GraphicsLayer.js';
import type SceneLayer from '@arcgis/core/layers/SceneLayer.js';
import type Graphic from '@arcgis/core/Graphic.js';
import type { PointSymbol3DProperties } from '@arcgis/core/symbols/PointSymbol3D.js';
import type { PolygonSymbol3DProperties } from '@arcgis/core/symbols/PolygonSymbol3D.js';
import type { SceneLayerProperties } from '@arcgis/core/layers/SceneLayer.js';
import type { Area, DepthClass, FacilityCollection, PublicConfig } from './flood-api.service';

export const DEPTH_COLORS: Record<DepthClass, string> = {
  dry: '#4fd1c5',
  shallow: '#f6a623',
  deep: '#ff4d4f',
};

/** Lazily-loaded ArcGIS modules (keeps the SDK out of the initial bundle). */
async function loadArcgis() {
  const [esriConfig, Map, SceneViewCls, GraphicsLayerCls, SceneLayerCls, GraphicCls, Polygon, Point, Camera, SolidEdges3D] = await Promise.all([
    import('@arcgis/core/config.js'),
    import('@arcgis/core/Map.js'),
    import('@arcgis/core/views/SceneView.js'),
    import('@arcgis/core/layers/GraphicsLayer.js'),
    import('@arcgis/core/layers/SceneLayer.js'),
    import('@arcgis/core/Graphic.js'),
    import('@arcgis/core/geometry/Polygon.js'),
    import('@arcgis/core/geometry/Point.js'),
    import('@arcgis/core/Camera.js'),
    import('@arcgis/core/symbols/edges/SolidEdges3D.js'),
  ]);
  return {
    esriConfig: esriConfig.default,
    Map: Map.default,
    SceneView: SceneViewCls.default,
    GraphicsLayer: GraphicsLayerCls.default,
    SceneLayer: SceneLayerCls.default,
    Graphic: GraphicCls.default,
    Polygon: Polygon.default,
    Point: Point.default,
    Camera: Camera.default,
    SolidEdges3D: SolidEdges3D.default,
  };
}
type Arcgis = Awaited<ReturnType<typeof loadArcgis>>;

function pinSymbol(depth: DepthClass): PointSymbol3DProperties & { type: 'point-3d' } {
  const color = DEPTH_COLORS[depth];
  const dry = depth === 'dry';
  return {
    type: 'point-3d',
    verticalOffset: { screenLength: dry ? 22 : 38, maxWorldLength: 260, minWorldLength: 18 },
    callout: { type: 'line', size: 1, color: dry ? [79, 209, 197, 0.45] : color },
    symbolLayers: [
      {
        type: 'icon',
        resource: { primitive: 'circle' },
        size: dry ? 7 : 12,
        material: { color: dry ? [79, 209, 197, 0.7] : color },
        outline: { color: dry ? [10, 20, 30, 0.6] : [255, 255, 255, 0.85], size: dry ? 0.5 : 1.2 },
      },
    ],
  };
}

@Component({
  selector: 'app-scene-view',
  template: `
    <div #host class="host"></div>
    @if (status(); as s) {
      <div class="status" [class.error]="s.error">{{ s.text }}</div>
    }
  `,
  styles: `
    :host { position: absolute; inset: 0; display: block; }
    .host { position: absolute; inset: 0; }
    .status {
      position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
      padding: 10px 16px; border-radius: 10px; background: rgba(9, 14, 20, 0.8);
      color: #cbd5e1; font-size: 14px; pointer-events: none;
    }
    .status.error { color: #fca5a5; }
  `,
})
export class SceneViewComponent implements OnDestroy {
  readonly config = input.required<PublicConfig>();
  readonly area = input<Area | null>(null);
  readonly facilities = input<FacilityCollection | null>(null);
  /** facility id -> depth class at the current water level */
  readonly depthById = input<Map<string, DepthClass>>(new Map());
  readonly waterLevel = input(0);
  readonly showFacilities = input(true);
  readonly showBuildings = input(true);
  readonly showWater = input(true);
  readonly focus = input<[number, number] | null>(null);

  readonly facilityClick = output<string>();
  readonly buildingsAvailable = output<boolean>();

  private readonly host = viewChild.required<ElementRef<HTMLDivElement>>('host');
  protected readonly status = signal<{ text: string; error?: boolean } | null>({ text: 'Loading 3D scene…' });

  private esri?: Arcgis;
  private view?: SceneView;
  private facilityLayer?: GraphicsLayer;
  private waterLayer?: GraphicsLayer;
  private buildings?: SceneLayer;
  private graphicsById = new Map<string, Graphic>();
  private ready = signal(false);
  private shownLevel = 0;
  private animation = 0;

  constructor() {
    effect(() => {
      const cfg = this.config();
      untracked(() => this.init(cfg));
    });

    // Fly to the area and rebuild water when the area changes.
    effect(() => {
      const area = this.area();
      if (!this.ready() || !area) return;
      untracked(() => {
        this.flyTo(area);
        this.drawWater(area, this.waterLevel(), false);
      });
    });

    effect(() => {
      const fc = this.facilities();
      if (!this.ready()) return;
      untracked(() => this.drawFacilities(fc));
    });

    effect(() => {
      const depths = this.depthById();
      if (!this.ready()) return;
      untracked(() => this.restyle(depths));
    });

    effect(() => {
      const level = this.waterLevel();
      if (!this.ready()) return;
      untracked(() => {
        const area = this.area();
        if (area) this.drawWater(area, level, true);
      });
    });

    effect(() => {
      const [f, b, w] = [this.showFacilities(), this.showBuildings(), this.showWater()];
      if (!this.ready()) return;
      if (this.facilityLayer) this.facilityLayer.visible = f;
      if (this.buildings) this.buildings.visible = b;
      if (this.waterLayer) this.waterLayer.visible = w;
    });

    effect(() => {
      const target = this.focus();
      if (!this.ready() || !target || !this.view) return;
      this.view
        .goTo({ center: [target[0], target[1], 0], zoom: 16, tilt: 62 }, { duration: 1400 })
        .catch(() => undefined);
    });
  }

  private async init(cfg: PublicConfig) {
    try {
      const esri = (this.esri = await loadArcgis());
      if (cfg.arcgisApiKey) esri.esriConfig.apiKey = cfg.arcgisApiKey;

      this.waterLayer = new esri.GraphicsLayer({ title: 'Water', elevationInfo: { mode: 'absolute-height' } });
      this.facilityLayer = new esri.GraphicsLayer({ title: 'Facilities', elevationInfo: { mode: 'relative-to-ground' } });
      this.buildings = new esri.SceneLayer({
        url: cfg.buildingsLayerUrl,
        title: '3D buildings',
        popupEnabled: false,
        renderer: {
          type: 'simple',
          symbol: {
            type: 'mesh-3d',
            symbolLayers: [{ type: 'fill', material: { color: [200, 208, 216, 0.92], colorMixMode: 'replace' }, edges: new esri.SolidEdges3D({ color: [20, 28, 36, 0.35], size: 0.4 }) }],
          },
        },
      } satisfies SceneLayerProperties);

      const map = new esri.Map({
        basemap: 'satellite',
        ground: 'world-elevation',
        layers: [this.buildings, this.waterLayer, this.facilityLayer],
      });

      const view = (this.view = new esri.SceneView({
        container: this.host().nativeElement,
        map,
        qualityProfile: 'high',
        environment: {
          atmosphereEnabled: true,
          starsEnabled: false,
          lighting: { type: 'sun', directShadowsEnabled: true },
        },
        ui: { components: [] }, // Esri attribution is always shown by the SDK
        popupEnabled: false,
      }));

      this.buildings.load().then(
        () => this.buildingsAvailable.emit(true),
        () => {
          this.buildingsAvailable.emit(false);
          if (this.buildings) this.buildings.visible = false;
        },
      );

      view.on('click', async (event) => {
        const hit = await view.hitTest(event, { include: [this.facilityLayer!] });
        const g = hit.results.find((r) => r.type === 'graphic');
        const id = g && 'graphic' in g ? (g.graphic.attributes?.id as string | undefined) : undefined;
        if (id) this.facilityClick.emit(id);
      });

      const slow = setTimeout(
        () => this.status.set({ text: 'Still loading the 3D scene… check network access to ArcGIS services.' }),
        20_000,
      );
      await view.when();
      clearTimeout(slow);
      this.status.set(null);
      this.ready.set(true);
    } catch (err) {
      console.error(err);
      this.status.set({ text: 'The 3D scene could not load. Check WebGL support and network access to ArcGIS.', error: true });
    }
  }

  private flyTo(area: Area) {
    const esri = this.esri;
    if (!esri) return;
    const [lon, lat, z] = area.camera.position;
    this.view
      ?.goTo(
        new esri.Camera({ position: new esri.Point({ longitude: lon, latitude: lat, z }), heading: area.camera.heading, tilt: area.camera.tilt }),
        { duration: 2200 },
      )
      .catch(() => undefined);
  }

  private drawFacilities(fc: FacilityCollection | null) {
    const esri = this.esri;
    if (!esri || !this.facilityLayer) return;
    this.facilityLayer.removeAll();
    this.graphicsById.clear();
    if (!fc) return;
    const depths = this.depthById();
    const graphics = fc.features.map((f) => {
      const g = new esri.Graphic({
        geometry: new esri.Point({ longitude: f.geometry.coordinates[0], latitude: f.geometry.coordinates[1] }),
        attributes: { id: f.properties.id, name: f.properties.name },
        symbol: pinSymbol(depths.get(f.properties.id) ?? 'dry'),
      });
      this.graphicsById.set(f.properties.id, g);
      return g;
    });
    this.facilityLayer.addMany(graphics);
  }

  private restyle(depths: Map<string, DepthClass>) {
    for (const [id, g] of this.graphicsById) {
      g.symbol = pinSymbol(depths.get(id) ?? 'dry') as unknown as Graphic['symbol'];
    }
  }

  /** Water surface: the area's extent as a polygon at the scenario height, with a water material. */
  private drawWater(area: Area, level: number, animate: boolean) {
    const esri = this.esri;
    const layer = this.waterLayer;
    if (!esri || !layer) return;
    cancelAnimationFrame(this.animation);

    const [w, s, e, n] = area.bbox;
    const pad = 0.04;
    const make = (z: number) => {
      const h = Math.max(z, 0.2); // keep the 0 m surface just above the terrain's sea surface
      return new esri.Polygon({
        hasZ: true,
        spatialReference: { wkid: 4326 },
        rings: [[[w - pad, s - pad, h], [e + pad, s - pad, h], [e + pad, n + pad, h], [w - pad, n + pad, h], [w - pad, s - pad, h]]],
      });
    };

    let graphic = layer.graphics.getItemAt(0);
    if (!graphic) {
      graphic = new esri.Graphic({
        geometry: make(level),
        symbol: {
          type: 'polygon-3d',
          symbolLayers: [{ type: 'water', color: '#1b3f4f', waveStrength: 'moderate', waterbodySize: 'large', waveDirection: 160 }],
        } satisfies PolygonSymbol3DProperties & { type: 'polygon-3d' },
      });
      layer.add(graphic);
      this.shownLevel = level;
      return;
    }

    const from = animate ? this.shownLevel : level;
    const start = performance.now();
    const duration = animate ? 700 : 0;
    const step = (t: number) => {
      const k = duration ? Math.min(1, (t - start) / duration) : 1;
      const eased = 1 - Math.pow(1 - k, 3);
      const z = from + (level - from) * eased;
      graphic!.geometry = make(z);
      this.shownLevel = z;
      if (k < 1) this.animation = requestAnimationFrame(step);
    };
    this.animation = requestAnimationFrame(step);
  }

  ngOnDestroy() {
    cancelAnimationFrame(this.animation);
    this.view?.destroy();
  }
}
