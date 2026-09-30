// Types for the parts of gifenc (https://github.com/mattdesl/gifenc) that render.ts uses.
// Node loads it as CommonJS, so everything comes through the default export.
declare module "gifenc" {
  type Palette = number[][];
  const gifenc: {
    quantize(rgba: Uint8Array | Buffer, maxColors: number): Palette;
    applyPalette(rgba: Uint8Array | Buffer, palette: Palette): Uint8Array;
    GIFEncoder(): {
      writeFrame(index: Uint8Array, width: number, height: number, options: { palette: Palette; delay?: number }): void;
      finish(): void;
      bytes(): Uint8Array;
    };
  };
  export default gifenc;
}
