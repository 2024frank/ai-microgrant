import { getSharp } from '@/lib/sharp';
import { loadImageAsJpeg } from '@/lib/safeRemoteImage';

describe('Sharp production runtime', () => {
  it('loads the native addon and normalizes a real raster into JPEG bytes', async () => {
    const png = await getSharp()({
      create: {
        width: 2,
        height: 2,
        channels: 3,
        background: { r: 20, g: 40, b: 60 },
      },
    }).png().toBuffer();

    const jpeg = await loadImageAsJpeg(
      `data:image/png;base64,${png.toString('base64')}`,
    );

    expect(jpeg.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  });
});
