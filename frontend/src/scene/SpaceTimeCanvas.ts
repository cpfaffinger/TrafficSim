import { speedColorBytes } from '../lib/colorScale';

/** Scrolling space-time heatmap: x = time (newest right), y = position along the ring. */
export class SpaceTimeCanvas {
  private readonly ctx: CanvasRenderingContext2D;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    readonly cells: number,
    columns = 600,
  ) {
    canvas.width = columns;
    canvas.height = cells;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas not supported');
    this.ctx = ctx;
    this.clear();
  }

  clear(): void {
    this.ctx.fillStyle = '#20232a';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  push(ratios: Float32Array): void {
    const { width, height } = this.canvas;
    this.ctx.drawImage(this.canvas, 1, 0, width - 1, height, 0, 0, width - 1, height);
    const column = this.ctx.createImageData(1, height);
    for (let cell = 0; cell < height; cell++) {
      const ratio = ratios[cell] ?? Number.NaN;
      const offset = (height - 1 - cell) * 4;
      if (Number.isNaN(ratio)) {
        column.data.set([32, 35, 42, 255], offset);
      } else {
        const [r, g, b] = speedColorBytes(ratio);
        column.data.set([r, g, b, 255], offset);
      }
    }
    this.ctx.putImageData(column, width - 1, 0);
  }
}
