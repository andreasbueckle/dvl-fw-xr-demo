import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import {
  ArcRotateCamera,
  Color3,
  Color4,
  DynamicTexture,
  Engine,
  HemisphericLight,
  Matrix,
  Mesh,
  MeshBuilder,
  Node,
  Ray,
  Scene,
  StandardMaterial,
  TransformNode,
  UniversalCamera,
  Vector3,
  WebXRControllerMovement,
  WebXRDefaultExperience,
  WebXRFeatureName,
  WebXRState,
} from '@babylonjs/core';
import { AdvancedDynamicTexture, Button, Control, Rectangle, Slider, StackPanel, TextBlock, type TextWrapping } from '@babylonjs/gui';
import * as anu from '@jpmorganchase/anu';
import { scaleBand, scaleLinear, scaleOrdinal } from 'd3-scale';
import {
  loadSpotify,
  loadSpotifyFeatured,
  loadSpotifyNames,
  loadBoroughs,
  loadPenguins,
  loadTaxiTrips,
  SpotifyColumns,
  SpotifyFeatured,
  Borough,
  Penguin,
  SpotifyNames,
  TaxiTrips,
} from './data';
import { PointGrid } from './point-grid';

type ChartType = 'scatter' | 'penguins' | 'taxi';
type NavMode = 'orbit' | 'fly';

/** A chart whose points show details on hover. */
interface HoverTarget {
  chart: ChartType;
  /** The node whose local space `positions` are in. */
  node: TransformNode;
  /** x, y, z per point. */
  positions: Float32Array;
  grid: PointGrid;
  /** Point i's pick radius in `node`'s space at scale 1 (0: not pickable); shrinks with the scale. */
  radius(i: number): number;
  /** White mark drawn over the hovered point. */
  highlight: Mesh;
  /** Size of the highlight for point i, relative to its base size. */
  highlightScale?(i: number): number;
  /** Called the first time the chart is hovered with Details on. */
  activate?: () => void;
  /** Label title and subtitle for point i. */
  describe(i: number): [string, string];
}

const CHARTS: { id: ChartType; label: string }[] = [
  { id: 'penguins', label: 'Penguins' },
  { id: 'taxi', label: 'NYC Taxi' },
  { id: 'scatter', label: 'Spotify' },
];

// Every chart fills a 1m cube whose centre sits at roughly eye height.
const CHART_CENTER_Y = 1.2;
const VR_IDLE_STATUS = 'Click the goggles icon (bottom right) to enter VR.';
const POINT_SIZE = 0.005;
/** Artists whose songs can be picked out in the Spotify chart (see scripts/prepare-data.mjs). */
const FEATURED_ARTISTS = ['Taylor Swift', 'Billie Eilish', 'Kacey Musgraves', 'Cardi B', 'Johann Sebastian Bach'];
/** Picked-out songs are drawn this much larger: a few 5mm cubes on their own are nearly invisible. */
const FEATURED_SIZE = 4;
const MAX_SCALE = 10;
const FLY_SPEED = 0.03;
const XR_MOVEMENT_SPEED = 0.03;
const FLY_HINT = 'W A S D / arrows: move · E / Q: up / down · drag: look';

@Component({
  selector: 'app-charts-xr',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <canvas #canvas tabindex="0"></canvas>
    <div class="status">{{ status() }}</div>
    <div class="toolbar">
      <div class="switcher" role="group" aria-label="Chart type">
        @for (c of charts; track c.id) {
          <button type="button" [class.active]="chart() === c.id" [attr.aria-pressed]="chart() === c.id" (click)="chart.set(c.id)">
            {{ c.label }}
          </button>
        }
      </div>
      <div class="switcher" role="group" aria-label="Navigation">
        <button type="button" [class.active]="nav() === 'orbit'" [attr.aria-pressed]="nav() === 'orbit'" (click)="setNav('orbit')">Orbit</button>
        <button type="button" [class.active]="nav() === 'fly'" [attr.aria-pressed]="nav() === 'fly'" (click)="setNav('fly')">Fly</button>
      </div>
      <label class="switcher scale">
        Scale
        <input type="range" min="1" [max]="maxScale" step="0.1" [value]="scale()" (input)="scale.set($any($event.target).valueAsNumber)" />
        <span class="scale-value">×{{ scale().toFixed(1) }}</span>
      </label>
      <div class="switcher">
        <button type="button" [class.active]="hover()" [attr.aria-pressed]="hover()" title="Show track and artist on hover" (click)="hover.set(!hover())">
          Details
        </button>
      </div>
    </div>
    @if (chart() === 'scatter') {
      <div class="filters" role="group" aria-label="Songs to show">
        <label>
          <input type="checkbox" [checked]="showAllSongs()" (change)="showAllSongs.set($any($event.target).checked)" />
          All songs
        </label>
        @for (artist of featuredArtistNames; track artist) {
          <label>
            <input type="checkbox" [checked]="featuredArtists().includes(artist)" (change)="toggleArtist(artist)" />
            {{ artist }}
          </label>
        }
      </div>
    }
    @if (nav() === 'fly') {
      <div class="hint">{{ flyHint }}</div>
    }
  `,
  styles: `
    :host { display: block; position: relative; width: 100%; height: 100%; font: 13px system-ui, sans-serif; }
    canvas { width: 100%; height: 100%; display: block; outline: none; touch-action: none; }
    .status {
      position: absolute; top: 12px; left: 12px; padding: 6px 10px;
      color: #fff; background: rgb(0 0 0 / 0.55); border-radius: 6px;
    }
    .toolbar { position: absolute; top: 12px; right: 12px; display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
    .switcher { display: flex; gap: 4px; padding: 4px; background: rgb(0 0 0 / 0.55); border-radius: 8px; }
    .scale { align-items: center; gap: 8px; padding: 4px 10px; color: #ddd; }
    .scale input { width: 120px; accent-color: #2f6fde; }
    .scale-value { min-width: 3.5ch; font-variant-numeric: tabular-nums; }
    .filters {
      position: absolute; top: 60px; right: 12px; display: flex; flex-direction: column; gap: 6px;
      padding: 8px 12px; color: #ddd; background: rgb(0 0 0 / 0.55); border-radius: 8px;
    }
    .filters label { display: flex; align-items: center; gap: 8px; cursor: pointer; }
    .filters input { margin: 0; accent-color: #2f6fde; }
    .hint {
      position: absolute; bottom: 12px; left: 12px; padding: 6px 10px;
      color: #ddd; background: rgb(0 0 0 / 0.55); border-radius: 6px;
    }
    .switcher button {
      font: inherit; color: #ddd; background: transparent; border: 0; border-radius: 5px;
      padding: 6px 12px; cursor: pointer;
    }
    .switcher button:hover { background: rgb(255 255 255 / 0.12); }
    .switcher button.active { background: #2f6fde; color: #fff; }
  `,
})
export class ChartsXr {
  private readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  protected readonly charts = CHARTS;
  protected readonly chart = signal<ChartType>(CHARTS[0].id);
  protected readonly status = signal('Loading…');
  protected readonly nav = signal<NavMode>('orbit');
  /** Details on demand (hover labels) for the Spotify chart; off until the user turns it on. */
  protected readonly hover = signal(false);
  /** Spreads the charts out by this factor; the Spotify cubes keep their size. */
  protected readonly scale = signal(1);
  protected readonly maxScale = MAX_SCALE;
  /** Spotify songs to show: all of them, and/or those by the featured artists (drawn larger). */
  protected readonly showAllSongs = signal(true);
  protected readonly featuredArtists = signal<string[]>([]);
  protected readonly featuredArtistNames = FEATURED_ARTISTS;
  private scatterPoints?: {
    mesh: Mesh;
    matrices: Float32Array;
    /** Index into FEATURED_ARTISTS per song, or -1. */
    artistOf: Int8Array;
    /** Current size per song relative to POINT_SIZE: 0 hidden, 1 normal, FEATURED_SIZE picked out. */
    sizes: Float32Array;
  };
  private vrFilterRow?: StackPanel;
  private vrFilterButtons = new Map<string, Button>();
  private penguinMarks: Node[] = [];
  private hoverTargets: HoverTarget[] = [];
  /** Set when a hover label's text changes without the hovered point changing (e.g. names arrive). */
  private hoverDirty = false;
  private xrMovement?: WebXRControllerMovement;
  private vrScaleSlider?: Slider;
  private vrScaleLabel?: TextBlock;
  protected readonly flyHint = FLY_HINT;
  private cameras?: { scene: Scene; orbit: ArcRotateCamera; fly: UniversalCamera };
  private readonly views = signal<Record<ChartType, Node> | null>(null);
  private vrButtons: Partial<Record<ChartType, Button>> = {};
  private vrHoverButton?: Button;
  private xr?: WebXRDefaultExperience;
  private pointerInside = false;

  constructor() {
    const destroyRef = inject(DestroyRef);

    // Show only the selected chart and keep the in-VR panel's highlight in sync with the HTML buttons.
    effect(() => {
      const active = this.chart();
      const views = this.views();
      if (!views) return;
      for (const { id } of CHARTS) {
        setChartEnabled(views[id], id === active);
        const button = this.vrButtons[id];
        if (button) button.background = id === active ? '#2f6fde' : '#333a';
      }
    });

    effect(() => {
      const scale = this.scale();
      const views = this.views();
      if (!views) return;
      for (const { id } of CHARTS) (views[id] as TransformNode).scaling.setAll(scale);
      for (const mark of this.penguinMarks) (mark as Mesh).scaling.setAll(1 / scale);
      // Keep the time it takes to fly across the chart about the same.
      if (this.cameras) this.cameras.fly.speed = FLY_SPEED * scale;
      if (this.xrMovement) this.xrMovement.movementSpeed = XR_MOVEMENT_SPEED * scale;
      if (this.vrScaleSlider) this.vrScaleSlider.value = scale;
      if (this.vrScaleLabel) this.vrScaleLabel.text = scaleLabel(scale);
    });

    // Size each Spotify cube by the song filters, and shrink it by the chart's scale in its own space
    // so it keeps the same size in the world.
    effect(() => {
      const scale = this.scale();
      const showAll = this.showAllSongs();
      const picked = FEATURED_ARTISTS.map((a) => this.featuredArtists().includes(a));
      if (!this.views() || !this.scatterPoints) return;
      const { mesh, matrices, artistOf, sizes } = this.scatterPoints;
      for (let i = 0; i < sizes.length; i++) {
        const a = artistOf[i];
        sizes[i] = a >= 0 && picked[a] ? FEATURED_SIZE : showAll ? 1 : 0;
        const m = i * 16;
        matrices[m] = matrices[m + 5] = matrices[m + 10] = sizes[i] / scale;
      }
      mesh.thinInstanceBufferUpdated('matrix');
      this.syncVrFilterButtons();
    });

    effect(() => {
      this.chart();
      this.syncVrFilterButtons();
    });

    effect(() => {
      const on = this.hover();
      if (this.vrHoverButton) this.vrHoverButton.background = on ? '#2f6fde' : '#333a';
    });

    afterNextRender(() => {
      const engine = new Engine(this.canvas().nativeElement, true);
      const scene = this.createScene(engine);
      engine.runRenderLoop(() => scene.render());
      this.buildCharts(scene).then(() => this.enableXR(scene));
      const onResize = () => engine.resize();
      window.addEventListener('resize', onResize);
      destroyRef.onDestroy(() => {
        window.removeEventListener('resize', onResize);
        engine.dispose();
      });
    });
  }

  private createScene(engine: Engine): Scene {
    const scene = new Scene(engine);
    scene.clearColor.set(0.08, 0.09, 0.12, 1);
    const light = new HemisphericLight('light', new Vector3(0, 10, 0), scene);
    light.groundColor = new Color3(0.4, 0.4, 0.4);

    const camera = new ArcRotateCamera('cam', -Math.PI / 4, Math.PI / 2.5, 2.5, new Vector3(0, CHART_CENTER_Y, 0), scene);
    camera.wheelPrecision = 50;
    camera.minZ = 0.01;
    camera.attachControl(true);

    // Free-flying alternative to the orbit camera; it takes over the orbit camera's pose when enabled.
    const fly = new UniversalCamera('fly', camera.position.clone(), scene);
    fly.minZ = camera.minZ;
    // Babylon scales speed by frame time and inertia; this works out to roughly 0.1 m/s, slow enough for close inspection.
    fly.speed = FLY_SPEED;
    fly.keysUp = [87, 38]; // W, ↑
    fly.keysDown = [83, 40]; // S, ↓
    fly.keysLeft = [65, 37]; // A, ←
    fly.keysRight = [68, 39]; // D, →
    fly.keysUpward = [69]; // E
    fly.keysDownward = [81]; // Q
    this.cameras = { scene, orbit: camera, fly };
    return scene;
  }

  protected toggleArtist(artist: string): void {
    this.featuredArtists.update((list) => (list.includes(artist) ? list.filter((a) => a !== artist) : [...list, artist]));
  }

  /** The in-VR song filters only apply to the Spotify chart; keep them in sync with the checkboxes. */
  private syncVrFilterButtons(): void {
    if (!this.vrFilterRow) return;
    this.vrFilterRow.isVisible = this.chart() === 'scatter';
    for (const [key, button] of this.vrFilterButtons) {
      const on = key === 'all' ? this.showAllSongs() : this.featuredArtists().includes(key);
      button.background = on ? '#2f6fde' : '#333a';
    }
  }

  protected setNav(mode: NavMode): void {
    if (!this.cameras || mode === this.nav()) return;
    const { scene, orbit, fly } = this.cameras;
    if (mode === 'fly') {
      fly.position.copyFrom(orbit.position);
      fly.setTarget(orbit.target);
    } else {
      // Resume orbiting the chart from wherever the user flew to.
      orbit.setPosition(fly.position.clone());
    }
    const [from, to] = mode === 'fly' ? [orbit, fly] : [fly, orbit];
    from.detachControl();
    to.attachControl(true);
    scene.activeCamera = to;
    this.nav.set(mode);
    // Keyboard input goes to the canvas, not the button that was just clicked.
    this.canvas().nativeElement.focus();
  }

  private async buildCharts(scene: Scene): Promise<void> {
    this.status.set('Loading data…');
    let data: [SpotifyColumns, SpotifyFeatured, Penguin[], TaxiTrips, Borough[]];
    try {
      data = await Promise.all([loadSpotify(), loadSpotifyFeatured(), loadPenguins(), loadTaxiTrips(), loadBoroughs()]);
    } catch (err) {
      this.status.set(String(err instanceof Error ? err.message : err));
      throw err;
    }
    const [spotify, featured, penguins, trips, boroughs] = data;
    this.views.set({
      scatter: this.createScatter(scene, spotify, featured),
      penguins: this.createPenguins(scene, penguins),
      taxi: this.createTaxi(scene, trips, boroughs),
    });
    this.setupHover(scene);
    this.createVrPanel(scene);
  }

  /**
   * Danceability (x), energy (y), popularity (z) and duration (colour) for every track. With ~130k
   * points, separate meshes would be far too slow, so all points are thin instances of one small box:
   * a single draw call. Anu's bindThinInstance helpers allocate a Matrix per point (and 3x the
   * buffer), so the instance buffers are written directly here; Anu still provides the chart root,
   * axes and colour scale.
   */
  private createScatter(scene: Scene, data: SpotifyColumns, featured: SpotifyFeatured): Node {
    const count = data.popularity.length;
    const scaleX = scaleLinear().domain([0, 1]).range([-0.5, 0.5]);
    const scaleY = scaleLinear().domain([0, 1]).range([-0.5, 0.5]);
    const scaleZ = scaleLinear().domain([0, 100]).range([-0.5, 0.5]);
    // Colour = duration in minutes. Durations run from seconds to over an hour, but the median is
    // ~3.4 min and 99% are under 10 min, so the scale stops at 10 min; longer tracks clamp to yellow.
    const viridis = anu.sequentialChromatic('Viridis').toColor3();
    const scaleC = scaleLinear().domain([0, 10]).range([0, 1]).clamp(true);

    const chart = anu.bind('cot', {}, [{}], scene);
    chart.positionY(CHART_CENTER_Y);
    const root = chart.selected[0];

    // Boxes, not spheres: at 12 triangles each, 130k of them stay affordable on standalone headsets.
    const points = MeshBuilder.CreateBox('spotify-points', { size: POINT_SIZE }, scene);
    points.parent = root;
    const mat = new StandardMaterial('spotify-mat', scene);
    mat.specularColor = Color3.Black();
    points.material = mat;
    // Babylon's picking would test all 130k instances per ray; hover uses a PointGrid instead.
    points.isPickable = false;

    const matrices = new Float32Array(count * 16);
    const colors = new Float32Array(count * 4);
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const m = i * 16;
      positions.set([scaleX(data.danceability[i]), scaleY(data.energy[i]), scaleZ(data.popularity[i])], i * 3);
      matrices[m] = matrices[m + 5] = matrices[m + 10] = matrices[m + 15] = 1;
      matrices.set(positions.subarray(i * 3, i * 3 + 3), m + 12);
      const c = viridis(scaleC(data.duration_ms[i] / 60000));
      colors.set([c.r, c.g, c.b, 1], i * 4);
    }
    // Not static: the scale slider and song filters rewrite the instance scaling.
    points.thinInstanceSetBuffer('matrix', matrices, 16, false);
    const artistOf = new Int8Array(count).fill(-1);
    FEATURED_ARTISTS.forEach((artist, a) => featured[artist]?.forEach((i) => (artistOf[i] = a)));
    const sizes = new Float32Array(count).fill(1);
    this.scatterPoints = { mesh: points, matrices, artistOf, sizes };
    points.thinInstanceSetBuffer('color', colors, 4, true);
    points.thinInstanceRefreshBoundingInfo();

    anu.createAxes('scatter-axes', scene, { parent: chart, scale: { x: scaleX, y: scaleY, z: scaleZ } });
    addAxisTitles(scene, root, { x: 'Danceability', y: 'Energy', z: 'Popularity' });
    addColorLegend(scene, root, {
      title: 'Duration (min)',
      ticks: [0, 2, 4, 6, 8, 10],
      color: (minutes) => viridis(scaleC(minutes)),
      format: (minutes) => (minutes === 10 ? '10+' : String(minutes)),
      // Beside the chart's right-hand corner as seen from the default camera.
      position: new Vector3(0.8, 0, 0.8),
    });
    // The names file is ~2 MB, so only fetch it once someone actually hovers this chart.
    let names: SpotifyNames | undefined;
    this.hoverTargets.push({
      chart: 'scatter',
      node: points,
      positions,
      // Pick a little wider than the boxes themselves, which are only a few pixels across.
      grid: new PointGrid(positions, POINT_SIZE * FEATURED_SIZE),
      radius: (i) => POINT_SIZE * sizes[i],
      highlight: createHighlight(scene, MeshBuilder.CreateBox('spotify-hover', { size: POINT_SIZE * 2.5 }, scene)),
      highlightScale: (i) => Math.max(1, sizes[i]),
      activate: () =>
        loadSpotifyNames()
          .then((n) => {
            names = n;
            this.hoverDirty = true;
          })
          .catch((err) => console.error(err)),
      describe: (i) => (names ? [names.track[i], names.artist[i]] : ['Loading track names…', '']),
    });
    return root;
  }

  /**
   * Details on demand: the point under the mouse, or under a VR controller's ray, is highlighted and
   * labelled (see HoverTarget). The label is part of the scene so it also works in VR.
   */
  private setupHover(scene: Scene): void {
    const label = createHoverLabel(scene);
    const activated = new Set<HoverTarget>();
    let current: { target: HoverTarget; index: number } | undefined;
    const show = (hit: typeof current) => {
      if (current && current.target !== hit?.target) current.target.highlight.setEnabled(false);
      current = hit;
      label.mesh.setEnabled(!!hit);
      if (!hit) return;
      const { target, index } = hit;
      const [x, y, z] = target.positions.subarray(index * 3, index * 3 + 3);
      target.highlight.setEnabled(true);
      target.highlight.scaling.setAll(target.highlightScale?.(index) ?? 1);
      Vector3.TransformCoordinatesFromFloatsToRef(x, y, z, target.node.getWorldMatrix(), target.highlight.position);
      label.mesh.position.copyFrom(target.highlight.position).addInPlaceFromFloats(0, 0.06, 0);
      label.setText(...target.describe(index));
    };

    const canvas = scene.getEngine().getRenderingCanvas()!;
    canvas.addEventListener('pointermove', () => (this.pointerInside = true));
    canvas.addEventListener('pointerleave', () => (this.pointerInside = false));
    const toLocal = new Matrix();
    let lastWorldUpdate = -1;
    scene.onBeforeRenderObservable.add(() => {
      const target = this.hover() ? this.hoverTargets.find((t) => t.chart === this.chart()) : undefined;
      let hit: typeof current;
      if (target) {
        if (!activated.has(target)) {
          activated.add(target);
          target.activate?.();
        }
        target.node.getWorldMatrix().invertToRef(toLocal);
        for (const ray of this.pointerRays(scene)) {
          const index = target.grid.pick(Ray.Transform(ray, toLocal), (i) => target.radius(i) / this.scale());
          if (index >= 0) {
            hit = { target, index };
            break;
          }
        }
      }
      const worldUpdate = target?.node.getWorldMatrix().updateFlag ?? -1;
      // Also refresh when the label's text changed or the slider moved the hovered point.
      if (hit?.target !== current?.target || hit?.index !== current?.index || this.hoverDirty || worldUpdate !== lastWorldUpdate) {
        show(hit);
      }
      this.hoverDirty = false;
      lastWorldUpdate = worldUpdate;
    });
  }

  /** World-space rays from the VR controllers when in VR, otherwise from the mouse. */
  private pointerRays(scene: Scene): Ray[] {
    if (this.xr?.baseExperience.state === WebXRState.IN_XR) {
      return this.xr.input.controllers.map((controller) => {
        const ray = new Ray(Vector3.Zero(), Vector3.Forward());
        controller.getWorldPointerRayToRef(ray);
        return ray;
      });
    }
    if (!this.pointerInside || !scene.activeCamera) return [];
    return [scene.createPickingRay(scene.pointerX, scene.pointerY, Matrix.Identity(), scene.activeCamera)];
  }

  /** Palmer penguins' bill length (x), flipper length (y) and bill depth (z), coloured by species. */
  private createPenguins(scene: Scene, penguins: Penguin[]): Node {
    const scaleX = scaleLinear().domain(extent(penguins.map((d) => d.billLength))).range([-0.5, 0.5]).nice();
    const scaleY = scaleLinear().domain(extent(penguins.map((d) => d.flipperLength))).range([-0.5, 0.5]).nice();
    const scaleZ = scaleLinear().domain(extent(penguins.map((d) => d.billDepth))).range([-0.5, 0.5]).nice();
    const species = [...new Set(penguins.map((d) => d.species))].sort();
    const materials = categoryMaterials(scene, 'penguins');
    const scaleC = scaleOrdinal<string, StandardMaterial>().domain(species).range(materials);

    // ~340 points, so plain meshes (one per penguin, sharing a material per species) are fine here.
    const size = 0.025;
    const chart = anu.bind('cot', {}, [{}], scene);
    chart.positionY(CHART_CENTER_Y);
    const marks = chart
      .bind('box', { size }, penguins)
      .positionX((d: Penguin) => scaleX(d.billLength))
      .positionY((d: Penguin) => scaleY(d.flipperLength))
      .positionZ((d: Penguin) => scaleZ(d.billDepth))
      .prop('material', (d: Penguin) => scaleC(d.species));
    // The scale slider counter-scales these so they keep their size, like the Spotify cubes.
    this.penguinMarks = marks.selected;
    anu.createAxes('penguin-axes', scene, { parent: chart, scale: { x: scaleX, y: scaleY, z: scaleZ } });
    const root = chart.selected[0] as TransformNode;

    const positions = new Float32Array(penguins.length * 3);
    penguins.forEach((d, i) => positions.set([scaleX(d.billLength), scaleY(d.flipperLength), scaleZ(d.billDepth)], i * 3));
    this.hoverTargets.push({
      chart: 'penguins',
      node: root,
      positions,
      grid: new PointGrid(positions, size / 2),
      radius: () => size / 2,
      highlight: createHighlight(scene, MeshBuilder.CreateBox('penguin-hover', { size: size * 1.4 }, scene)),
      describe: (i) => {
        const d = penguins[i];
        return [d.species, `${d.island} · ${d.sex === 'unknown' ? 'sex unknown' : d.sex} · ${d.year}`];
      },
    });
    addAxisTitles(scene, root, { x: 'Bill length (mm)', y: 'Flipper length (mm)', z: 'Bill depth (mm)' });
    addCategoryLegend(scene, root, {
      title: 'Species',
      items: species.map((name) => ({ label: name, color: scaleC(name).diffuseColor })),
      position: new Vector3(0.8, 0, 0.8),
    });
    return root;
  }

  /**
   * One day of NYC taxi trips as arcs: each trip arcs from its pickup to its dropoff location,
   * higher for longer trips, coloured by pickup time. For orientation the floor shows borough
   * outlines and markers for the airports. Positions use Web Mercator so the city isn't stretched.
   * All arcs are one line system, so they cost a single draw call.
   */
  private createTaxi(scene: Scene, trips: TaxiTrips, boroughs: Borough[]): Node {
    const [lon0, lon1] = extent([extent(trips.pickupLon), extent(trips.dropoffLon)].flat());
    const [lat0, lat1] = extent([extent(trips.pickupLat), extent(trips.dropoffLat)].flat());
    // Corners in Mercator units (y grows southwards); the longer side spans 1m.
    const [mx0, my0] = mercator(lon0, lat1);
    const [mx1, my1] = mercator(lon1, lat0);
    const unitsPerMetre = Math.max(mx1 - mx0, my1 - my0);
    const width = (mx1 - mx0) / unitsPerMetre;
    const depth = (my1 - my0) / unitsPerMetre;
    // Trips start and end on the floor of the chart cube and arc up from it.
    const floorY = -0.5;
    const toScene = (lon: number, lat: number) => {
      const [mx, my] = mercator(lon, lat);
      return new Vector3((mx - mx0) / unitsPerMetre - width / 2, floorY, depth / 2 - (my - my0) / unitsPerMetre);
    };

    const viridis = anu.sequentialChromatic('Viridis').toColor3();
    const scaleC = scaleLinear().domain([0, 24]).range([0, 1]);
    const scaleFade = scaleLinear().domain([0, 10]).range([0, 1]).clamp(true);

    const chart = anu.bind('cot', {}, [{}], scene);
    chart.positionY(CHART_CENTER_Y);
    const root = chart.selected[0];

    addTaxiFloor(scene, root, toScene, width, depth, boroughs);

    const segments = 12;
    const lines: Vector3[][] = [];
    const colors: Color4[][] = [];
    for (let i = 0; i < trips.distance.length; i++) {
      const from = toScene(trips.pickupLon[i], trips.pickupLat[i]);
      const to = toScene(trips.dropoffLon[i], trips.dropoffLat[i]);
      // Quadratic Bézier whose peak is proportional to the trip's length on the map.
      const peak = Math.min(0.6, 0.5 * Vector3.Distance(from, to));
      const control = Vector3.Center(from, to).addInPlaceFromFloats(0, 2 * peak, 0);
      const arc: Vector3[] = [];
      for (let k = 0; k <= segments; k++) {
        const t = k / segments;
        arc.push(
          from.scale((1 - t) * (1 - t)).addInPlace(control.scale(2 * (1 - t) * t)).addInPlace(to.scale(t * t)),
        );
      }
      lines.push(arc);
      // Long trips (mostly to and from the airports) span most of the map and would paint over the
      // dense short trips, so they fade out as distance grows.
      const c = Color4.FromColor3(viridis(scaleC(trips.pickupHour[i])), 0.7 - 0.55 * scaleFade(trips.distance[i]));
      colors.push(arc.map(() => c));
    }
    const arcs = MeshBuilder.CreateLineSystem('taxi-trips', { lines, colors, useVertexAlpha: true }, scene);
    arcs.parent = root;
    arcs.isPickable = false;

    addColorLegend(scene, root, {
      title: 'Pickup (h)',
      ticks: [0, 6, 12, 18, 24],
      color: (hour) => viridis(scaleC(hour)),
      format: String,
      position: new Vector3(0.8, 0, 0.8),
    });
    return root;
  }

  /** HTML buttons are invisible inside an immersive session, so mirror them on a panel in the scene. */
  private createVrPanel(scene: Scene): void {
    const plane = MeshBuilder.CreatePlane('chart-switcher', { width: 0.8, height: 0.33 }, scene);
    // In front of the chart, on the side the default camera views it from, tilted up towards the viewer.
    plane.position = new Vector3(0.75, CHART_CENTER_Y - 0.65, -0.75);
    plane.rotation = new Vector3(Math.PI / 6, -Math.PI / 4, 0);

    const ui = AdvancedDynamicTexture.CreateForMesh(plane, 1340, 553);
    const rows = new StackPanel();
    ui.addControl(rows);
    const row = new StackPanel();
    row.isVertical = false;
    row.height = '190px';
    row.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    rows.addControl(row);

    const addButton = (name: string, label: string, onClick: () => void, parent = row, fontSize = 64, width = 320) => {
      const button = Button.CreateSimpleButton(name, label);
      button.width = `${width}px`;
      button.height = '180px';
      button.paddingLeft = button.paddingRight = '10px';
      button.color = 'white';
      button.fontSize = fontSize;
      button.cornerRadius = 20;
      button.thickness = 0;
      button.background = '#333a';
      button.onPointerUpObservable.add(onClick);
      parent.addControl(button);
      return button;
    };
    for (const { id, label } of CHARTS) this.vrButtons[id] = addButton(`vr-${id}`, label, () => this.chart.set(id));
    this.vrHoverButton = addButton('vr-hover', 'Details', () => this.hover.update((on) => !on));
    this.vrHoverButton.background = this.hover() ? '#2f6fde' : '#333a';

    const scaleRow = new StackPanel();
    scaleRow.isVertical = false;
    scaleRow.height = '170px';
    rows.addControl(scaleRow);
    const scaleText = new TextBlock('vr-scale-label', scaleLabel(this.scale()));
    scaleText.width = '360px';
    scaleText.color = 'white';
    scaleText.fontSize = 64;
    scaleRow.addControl(scaleText);
    const slider = new Slider('vr-scale');
    slider.minimum = 1;
    slider.maximum = MAX_SCALE;
    slider.step = 0.1;
    slider.value = this.scale();
    slider.width = '900px';
    slider.height = '80px';
    slider.color = '#2f6fde';
    slider.background = '#333a';
    slider.thumbColor = 'white';
    slider.isThumbCircle = true;
    slider.onValueChangedObservable.add((value) => this.scale.set(value));
    scaleRow.addControl(slider);
    this.vrScaleSlider = slider;
    this.vrScaleLabel = scaleText;

    // Song filters, shown while the Spotify chart is selected.
    const filterRow = new StackPanel();
    filterRow.isVertical = false;
    filterRow.height = '190px';
    rows.addControl(filterRow);
    // Six toggles share the panel's width, so they are narrower and long names wrap.
    const addFilter = (key: string, label: string, onClick: () => void) => {
      const button = addButton(`vr-filter-${key}`, label, onClick, filterRow, 40, 222);
      button.textBlock!.textWrapping = 1 satisfies TextWrapping; // TextWrapping.WordWrap
      this.vrFilterButtons.set(key, button);
    };
    addFilter('all', 'All songs', () => this.showAllSongs.update((on) => !on));
    for (const artist of FEATURED_ARTISTS) addFilter(artist, artist, () => this.toggleArtist(artist));
    this.vrFilterRow = filterRow;
    this.syncVrFilterButtons();
    // The effect may already have run before the buttons existed; re-trigger it.
    this.views.update((v) => (v ? { ...v } : v));
  }

  private async enableXR(scene: Scene): Promise<void> {
    if (!navigator.xr || !(await navigator.xr.isSessionSupported('immersive-vr').catch(() => false))) {
      this.status.set(
        window.isSecureContext
          ? 'WebXR immersive-vr not available — showing desktop view.'
          : 'WebXR requires HTTPS (or localhost) — showing desktop view.',
      );
      return;
    }
    // Fly instead of teleporting: the left thumbstick moves towards wherever the user is looking
    // (including up and down), the right thumbstick turns.
    const xr = await scene.createDefaultXRExperienceAsync({ disableTeleportation: true });
    this.xrMovement = xr.baseExperience.featuresManager.enableFeature(WebXRFeatureName.MOVEMENT, 'latest', {
      xrInput: xr.input,
      movementOrientationFollowsViewerPose: true,
      movementOrientationFollowsController: false,
      movementSpeed: XR_MOVEMENT_SPEED * this.scale(),
    }) as WebXRControllerMovement;
    renderPlaneTextPerEye(scene, xr);
    this.xr = xr;
    this.status.set(VR_IDLE_STATUS);
    xr.baseExperience.onStateChangedObservable.add((state) => {
      if (state === WebXRState.IN_XR) this.status.set('In VR');
      if (state === WebXRState.NOT_IN_XR) this.status.set(VR_IDLE_STATUS);
    });
  }
}

/**
 * Anu's PlaneText labels draw through their own text renderer and ignore their parents' enabled
 * state, so they have to be toggled individually alongside the chart's root node.
 */
function setChartEnabled(root: Node, enabled: boolean): void {
  root.setEnabled(enabled);
  for (const node of root.getDescendants(false)) {
    if (node instanceof anu.PlaneText) node.setEnabled(enabled);
  }
}

type TextRendererLike = { render(view: Matrix, projection: Matrix): void };

/**
 * Anu's PlaneText (axis titles and tick labels) is drawn by an MSDF TextRenderer once per frame,
 * after the scene has rendered, with scene.activeCamera's matrices. In WebXR each eye is a separate
 * rig camera with its own framebuffer, so that single pass lands in neither eye and all text
 * vanishes in the headset. While in XR, draw the same renderers after each eye instead, and mute
 * Anu's own pass so it can't draw a misplaced copy.
 */
function renderPlaneTextPerEye(scene: Scene, xr: WebXRDefaultExperience): void {
  const inXR = () => xr.baseExperience.state === WebXRState.IN_XR;
  let eyePass = false;
  const patched = new WeakSet<TextRendererLike>();
  const mute = (renderer: TextRendererLike) => {
    if (patched.has(renderer)) return;
    patched.add(renderer);
    const render = renderer.render.bind(renderer);
    renderer.render = (view, projection) => {
      if (eyePass || !inXR()) render(view, projection);
    };
  };

  scene.onAfterCameraRenderObservable.add((camera) => {
    if (!inXR() || !xr.baseExperience.camera.rigCameras.includes(camera)) return;
    eyePass = true;
    for (const node of scene.transformNodes) {
      if (!(node instanceof anu.PlaneText) || !node.isEnabled()) continue;
      // Private in Anu; set once the font has loaded.
      const renderer = (node as unknown as { textRenderer?: TextRendererLike }).textRenderer;
      if (!renderer) continue;
      mute(renderer);
      renderer.render(camera.getViewMatrix(), camera.getProjectionMatrix());
    }
    eyePass = false;
  });
}

/** Anu axes have tick labels but no titles; place one beside each axis of the 1m chart cube. */
function addAxisTitles(
  scene: Scene,
  parent: Node,
  titles: { x: string; y: string; z: string },
): void {
  const placements = [
    { text: titles.x, position: new Vector3(0, -0.66, -0.5), rotation: Vector3.Zero() },
    { text: titles.y, position: new Vector3(-0.72, 0, -0.5), rotation: new Vector3(0, 0, Math.PI / 2) },
    { text: titles.z, position: new Vector3(0.5, -0.66, 0), rotation: new Vector3(0, -Math.PI / 2, 0) },
  ];
  for (const { text, position, rotation } of placements) {
    const title = anu.createPlaneText(`title-${text}`, { text, size: 0.05, align: 'center' }, scene);
    title.parent = parent;
    title.position = position;
    title.rotation = rotation;
  }
}

/** Web Mercator position in a unit square: x grows eastwards, y southwards. */
function mercator(lon: number, lat: number): [number, number] {
  const sin = Math.sin((lat * Math.PI) / 180);
  return [(lon + 180) / 360, 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)];
}

const AIRPORTS = [
  { name: 'JFK', lon: -73.7781, lat: 40.6413 },
  { name: 'LaGuardia', lon: -73.874, lat: 40.7769 },
];

/** Where to put each borough's name (lon, lat): roughly central, and inside the trips' area. */
const BOROUGH_LABELS: Record<string, [number, number]> = {
  Manhattan: [-73.975, 40.785],
  Brooklyn: [-73.95, 40.65],
  Queens: [-73.83, 40.725],
  Bronx: [-73.88, 40.84],
};

/**
 * The taxi chart's floor: a dark plane, borough outlines (clipped to the plane), and labelled pins
 * for the airports, where the long trips end.
 */
function addTaxiFloor(
  scene: Scene,
  parent: Node,
  toScene: (lon: number, lat: number) => Vector3,
  width: number,
  depth: number,
  boroughs: Borough[],
): void {
  const floor = MeshBuilder.CreateGround('taxi-floor', { width, height: depth }, scene);
  floor.parent = parent;
  floor.position.y = toScene(0, 0).y - 0.002; // just under the outline and the arcs' end points
  const floorMat = new StandardMaterial('taxi-floor-mat', scene);
  floorMat.diffuseColor = Color3.Black();
  floorMat.specularColor = Color3.Black();
  floorMat.emissiveColor = new Color3(0.13, 0.14, 0.17);
  floor.material = floorMat;
  floor.isPickable = false;

  const bounds = { xMin: -width / 2, xMax: width / 2, zMin: -depth / 2, zMax: depth / 2 };
  const outlines = boroughs.flatMap((b) => b.rings.flatMap((ring) => clipPolyline(ring.map(([lon, lat]) => toScene(lon, lat)), bounds)));
  const outline = MeshBuilder.CreateLineSystem('borough-outlines', { lines: outlines }, scene);
  outline.parent = parent;
  outline.color = new Color3(0.75, 0.75, 0.75);
  outline.isPickable = false;
  for (const { name } of boroughs) {
    const at = BOROUGH_LABELS[name];
    if (at) addFloorLabel(scene, parent, name, toScene(...at).addInPlaceFromFloats(0, 0.03, 0));
  }

  const pinMat = new StandardMaterial('airport-pin-mat', scene);
  pinMat.diffuseColor = new Color3(1, 0.45, 0.2);
  pinMat.specularColor = Color3.Black();
  for (const { name, lon, lat } of AIRPORTS) {
    const base = toScene(lon, lat);
    const pin = MeshBuilder.CreateCylinder(`pin-${name}`, { height: 0.08, diameterTop: 0.012, diameterBottom: 0 }, scene);
    pin.parent = parent;
    pin.position = base.add(new Vector3(0, 0.04, 0));
    pin.material = pinMat;
    pin.isPickable = false;
    addFloorLabel(scene, parent, name, base.add(new Vector3(0, 0.11, 0)));
  }
}

/**
 * Clips a polyline in the x/z plane to a rectangle (Liang–Barsky per segment), returning the pieces
 * that lie inside; a line that leaves and re-enters becomes separate pieces.
 */
function clipPolyline(points: Vector3[], r: { xMin: number; xMax: number; zMin: number; zMax: number }): Vector3[][] {
  const pieces: Vector3[][] = [];
  let piece: Vector3[] | undefined;
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1], points[i]];
    const [dx, dz] = [b.x - a.x, b.z - a.z];
    let [t0, t1] = [0, 1];
    let inside = true;
    for (const [p, q] of [[-dx, a.x - r.xMin], [dx, r.xMax - a.x], [-dz, a.z - r.zMin], [dz, r.zMax - a.z]]) {
      if (p === 0) {
        if (q < 0) inside = false;
        continue;
      }
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
    }
    if (!inside || t0 > t1) {
      piece = undefined;
      continue;
    }
    // Continue the current piece if this segment starts inside, where the last one ended.
    if (!piece || t0 > 0) pieces.push((piece = [Vector3.Lerp(a, b, t0)]));
    piece.push(Vector3.Lerp(a, b, t1));
    if (t1 < 1) piece = undefined;
  }
  return pieces;
}

/** A text label that turns about the vertical axis to face the viewer. */
function addFloorLabel(scene: Scene, parent: Node, text: string, position: Vector3): void {
  const label = anu.createPlaneText(`label-${text}`, { text, size: 0.04, align: 'center' }, scene);
  label.parent = parent;
  label.position = position;
  label.billboardMode = TransformNode.BILLBOARDMODE_Y;
}

/** A vertical colour ramp with tick labels, drawn once into a texture on a plane that turns to face the viewer. */
function addColorLegend(
  scene: Scene,
  parent: Node,
  opts: {
    title: string;
    ticks: number[];
    color: (value: number) => Color3;
    format: (value: number) => string;
    position: Vector3;
  },
): void {
  const [width, height] = [320, 640];
  const texture = new DynamicTexture('legend-tex', { width, height }, scene, true);
  texture.hasAlpha = true;
  const ctx = texture.getContext() as unknown as CanvasRenderingContext2D;
  ctx.fillStyle = 'rgb(0 0 0 / 0.55)';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 36px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(opts.title, width / 2, 50);

  const [top, bottom, barX, barWidth] = [110, height - 40, 70, 60];
  const lo = opts.ticks[0];
  const hi = opts.ticks[opts.ticks.length - 1];
  const yOf = (v: number) => bottom - ((v - lo) / (hi - lo)) * (bottom - top);
  const gradient = ctx.createLinearGradient(0, bottom, 0, top);
  for (let s = 0; s <= 16; s++) gradient.addColorStop(s / 16, opts.color(lo + ((hi - lo) * s) / 16).toHexString());
  ctx.fillStyle = gradient;
  ctx.fillRect(barX, top, barWidth, bottom - top);

  ctx.fillStyle = '#fff';
  ctx.font = '34px system-ui, sans-serif';
  ctx.textAlign = 'left';
  for (const v of opts.ticks) {
    const y = yOf(v);
    ctx.fillRect(barX + barWidth, y - 1.5, 14, 3);
    ctx.fillText(opts.format(v), barX + barWidth + 24, y);
  }
  texture.update();
  addLegendPlane(scene, parent, texture, opts.position);
}

/** Colour swatches with labels, for a categorical colour scale. */
function addCategoryLegend(
  scene: Scene,
  parent: Node,
  opts: { title: string; items: { label: string; color: Color3 }[]; position: Vector3 },
): void {
  const rowHeight = 70;
  const [width, height] = [320, 110 + rowHeight * opts.items.length];
  const texture = new DynamicTexture('legend-tex', { width, height }, scene, true);
  texture.hasAlpha = true;
  const ctx = texture.getContext() as unknown as CanvasRenderingContext2D;
  ctx.fillStyle = 'rgb(0 0 0 / 0.55)';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 36px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(opts.title, width / 2, 50);
  ctx.font = '34px system-ui, sans-serif';
  ctx.textAlign = 'left';
  opts.items.forEach(({ label, color }, i) => {
    const y = 110 + rowHeight * i + rowHeight / 2 - 20;
    ctx.fillStyle = color.toHexString();
    ctx.fillRect(40, y - 20, 40, 40);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, 100, y);
  });
  texture.update();
  addLegendPlane(scene, parent, texture, opts.position);
}

/** Shows a legend texture on a plane that turns to face the viewer, at the texture's aspect ratio. */
function addLegendPlane(scene: Scene, parent: Node, texture: DynamicTexture, position: Vector3): void {
  const { width, height } = texture.getSize();
  const plane = MeshBuilder.CreatePlane('legend', { width: 0.24, height: (0.24 * height) / width }, scene);
  plane.parent = parent;
  plane.position = position;
  plane.billboardMode = Mesh.BILLBOARDMODE_Y;
  plane.isPickable = false;
  const mat = new StandardMaterial('legend-mat', scene);
  mat.emissiveTexture = texture;
  mat.opacityTexture = texture;
  mat.disableLighting = true;
  plane.material = mat;
}

/** Turns a mesh into a hidden white hover highlight that draws on top of everything else. */
function createHighlight(scene: Scene, mesh: Mesh): Mesh {
  const mat = new StandardMaterial(`${mesh.name}-mat`, scene);
  mat.emissiveColor = Color3.White();
  mat.disableLighting = true;
  mesh.material = mat;
  mesh.isPickable = false;
  // Rendering group 1 draws after the charts with a cleared depth buffer, so nothing hides the hover.
  mesh.renderingGroupId = 1;
  mesh.setEnabled(false);
  return mesh;
}

/** A two-line label (title, subtitle) on a plane that always faces the viewer. */
function createHoverLabel(scene: Scene): { mesh: Mesh; setText: (title: string, subtitle: string) => void } {
  const mesh = MeshBuilder.CreatePlane('hover-label', { width: 0.4, height: 0.1 }, scene);
  mesh.billboardMode = Mesh.BILLBOARDMODE_ALL;
  mesh.isPickable = false;
  mesh.renderingGroupId = 1;
  mesh.setEnabled(false);

  const ui = AdvancedDynamicTexture.CreateForMesh(mesh, 1024, 256);
  const box = new Rectangle();
  box.background = 'rgb(0 0 0 / 0.75)';
  box.cornerRadius = 24;
  box.thickness = 0;
  ui.addControl(box);
  const lines = new StackPanel();
  box.addControl(lines);
  const line = (fontSize: number, color: string, height: string) => {
    const text = new TextBlock();
    text.fontSize = fontSize;
    text.color = color;
    text.height = height;
    text.paddingLeft = text.paddingRight = '32px';
    text.textWrapping = 2 satisfies TextWrapping; // TextWrapping.Ellipsis (a const enum, unusable with isolatedModules)
    lines.addControl(text);
    return text;
  };
  const title = line(96, '#fff', '128px');
  const subtitle = line(72, '#bbb', '96px');
  title.fontWeight = 'bold';
  return {
    mesh,
    setText: (t, s) => {
      title.text = t;
      subtitle.text = s;
    },
  };
}

/** One shared material per category keeps draw calls low on standalone headsets. */
function categoryMaterials(scene: Scene, prefix: string): StandardMaterial[] {
  return anu.ordinalChromatic('d310').toColor3().map((color, i) => {
    const mat = new StandardMaterial(`${prefix}-${i}`, scene);
    mat.diffuseColor = color;
    mat.specularColor = Color3.Black();
    return mat;
  });
}

function scaleLabel(scale: number): string {
  return `Scale ×${scale.toFixed(1)}`;
}

function extent(values: ArrayLike<number>): [number, number] {
  // A loop rather than Math.min(...values): tens of thousands of arguments can overflow the stack.
  let [min, max] = [Infinity, -Infinity];
  for (let i = 0; i < values.length; i++) {
    min = Math.min(min, values[i]);
    max = Math.max(max, values[i]);
  }
  return [min, max];
}
