//! BGRA → NV12 color conversion.
//!
//! The ffmpeg pipe used to accept raw BGRA. That meant two costs we don't
//! need: (1) piping 4 bytes/pixel = ~2 GB/s at 4K60, right up against
//! Windows pipe bandwidth limits; and (2) ffmpeg's single-threaded
//! swscale BGRA→YUV420p conversion before handing frames to nvenc.
//!
//! Converting to NV12 on our side instead:
//!
//! - shrinks pipe traffic to 1.5 bytes/pixel (**2.67× less**, ~750 MB/s
//!   at 4K60, well below the pipe ceiling);
//! - lets us parallelize the conversion across all cores via Rayon
//!   instead of leaning on ffmpeg's serial swscale; and
//! - feeds nvenc the format it consumes natively, skipping swscale
//!   entirely inside ffmpeg.
//!
//! We use **BT.709 limited range** (a.k.a. "TV range"), which is what
//! ffmpeg's default BGRA→yuv420p path produces for HD+ content and what
//! nvenc expects unless `color_range=pc` is explicitly set. Using the
//! same colorspace avoids the subtle washed-out / crushed-blacks
//! mismatch you get if the encoder and source disagree.
//!
//! Coefficients are fixed-point with a 256 scale. Y land in 16..235 and
//! Cb/Cr in 16..240 by construction for clean 0..255 RGB input; we clamp
//! anyway to absorb rounding at the edges.

use rayon::prelude::*;

/// Convert a tight-packed BGRA buffer to NV12.
///
/// - `src` is `width * height * 4` bytes (BGRA, no alpha in the math).
/// - `dst` must be `width * height * 3 / 2` bytes exactly.
/// - `width` and `height` must both be even (chroma 4:2:0 subsampling).
///
/// Panics on any size mismatch rather than silently producing a garbled
/// stream — a mismatch here manifests as a weirdly-tinted video, which
/// is a much harder debugging session than a panic.
pub fn bgra_to_nv12(src: &[u8], width: u32, height: u32, dst: &mut [u8]) {
    let w = width as usize;
    let h = height as usize;
    assert!(w % 2 == 0 && h % 2 == 0, "NV12 requires even dimensions");
    assert_eq!(src.len(), w * h * 4, "bgra src size mismatch");
    assert_eq!(dst.len(), w * h * 3 / 2, "nv12 dst size mismatch");

    let y_plane_size = w * h;
    let (y_plane, uv_plane) = dst.split_at_mut(y_plane_size);

    let src_row_stride = w * 4;
    let uv_row_stride = w; // interleaved Cb,Cr pairs × (w/2) pairs = w bytes

    // Process pairs of source rows. Each pair maps to 2 Y rows + 1 UV row.
    y_plane
        .par_chunks_mut(w * 2)
        .zip(uv_plane.par_chunks_mut(uv_row_stride))
        .zip(src.par_chunks(src_row_stride * 2))
        .for_each(|((y_pair, uv_row), src_pair)| {
            let (src_row0, src_row1) = src_pair.split_at(src_row_stride);
            let (y_row0, y_row1) = y_pair.split_at_mut(w);
            let mut x = 0;
            while x + 2 <= w {
                let i0 = x * 4;
                let i1 = (x + 1) * 4;

                // BGRA — ignore alpha.
                let b00 = src_row0[i0] as i32;
                let g00 = src_row0[i0 + 1] as i32;
                let r00 = src_row0[i0 + 2] as i32;
                let b01 = src_row0[i1] as i32;
                let g01 = src_row0[i1 + 1] as i32;
                let r01 = src_row0[i1 + 2] as i32;
                let b10 = src_row1[i0] as i32;
                let g10 = src_row1[i0 + 1] as i32;
                let r10 = src_row1[i0 + 2] as i32;
                let b11 = src_row1[i1] as i32;
                let g11 = src_row1[i1 + 1] as i32;
                let r11 = src_row1[i1 + 2] as i32;

                // BT.709 limited-range Y.
                //   Y = (0.183·R + 0.614·G + 0.062·B) + 16
                // Coeffs ×256: R=47, G=157, B=16. Divider 256.
                y_row0[x]     = clamp_u8(((47 * r00 + 157 * g00 + 16 * b00 + 128) >> 8) + 16);
                y_row0[x + 1] = clamp_u8(((47 * r01 + 157 * g01 + 16 * b01 + 128) >> 8) + 16);
                y_row1[x]     = clamp_u8(((47 * r10 + 157 * g10 + 16 * b10 + 128) >> 8) + 16);
                y_row1[x + 1] = clamp_u8(((47 * r11 + 157 * g11 + 16 * b11 + 128) >> 8) + 16);

                // Chroma from a 2×2 box average. Summing the four pixels
                // and shifting by 10 (2 extra bits for the average, 8 for
                // the fixed-point scale) folds the divide-by-4 in for free.
                //   Cb = (-0.101·R - 0.339·G + 0.439·B) + 128
                //   Cr = ( 0.439·R - 0.399·G - 0.040·B) + 128
                // Coeffs ×256: Cb=(-26,-86,112), Cr=(112,-102,-10).
                let r = r00 + r01 + r10 + r11;
                let g = g00 + g01 + g10 + g11;
                let b = b00 + b01 + b10 + b11;
                let cb = (((-26 * r - 86 * g + 112 * b) + 512) >> 10) + 128;
                let cr = (((112 * r - 102 * g - 10 * b) + 512) >> 10) + 128;

                let uv_i = x; // x is always even; stores Cb,Cr interleaved
                uv_row[uv_i]     = clamp_u8(cb);
                uv_row[uv_i + 1] = clamp_u8(cr);

                x += 2;
            }
        });
}

#[inline(always)]
fn clamp_u8(v: i32) -> u8 {
    if v < 0 {
        0
    } else if v > 255 {
        255
    } else {
        v as u8
    }
}

/// Byte count of an NV12 buffer at the given dimensions. Always
/// `width * height * 3 / 2`; dims must be even.
pub fn nv12_byte_len(width: u32, height: u32) -> usize {
    (width as usize) * (height as usize) * 3 / 2
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_solid(width: u32, height: u32, b: u8, g: u8, r: u8) -> Vec<u8> {
        let mut v = Vec::with_capacity((width * height * 4) as usize);
        for _ in 0..(width * height) {
            v.extend_from_slice(&[b, g, r, 255]);
        }
        v
    }

    #[test]
    fn black_maps_to_y16_uv128() {
        let src = make_solid(4, 4, 0, 0, 0);
        let mut dst = vec![0u8; nv12_byte_len(4, 4)];
        bgra_to_nv12(&src, 4, 4, &mut dst);
        let (y, uv) = dst.split_at(16);
        assert!(y.iter().all(|&v| v == 16), "Y should be 16, got {:?}", y);
        assert!(uv.iter().all(|&v| v == 128), "UV should be 128, got {:?}", uv);
    }

    #[test]
    fn white_maps_to_y235_uv128() {
        let src = make_solid(4, 4, 255, 255, 255);
        let mut dst = vec![0u8; nv12_byte_len(4, 4)];
        bgra_to_nv12(&src, 4, 4, &mut dst);
        let (y, uv) = dst.split_at(16);
        for &v in y {
            assert!((234..=236).contains(&v), "Y ~235, got {v}");
        }
        for &v in uv {
            assert!((127..=129).contains(&v), "UV ~128, got {v}");
        }
    }

    #[test]
    fn red_has_high_cr() {
        let src = make_solid(4, 4, 0, 0, 255);
        let mut dst = vec![0u8; nv12_byte_len(4, 4)];
        bgra_to_nv12(&src, 4, 4, &mut dst);
        let uv = &dst[16..];
        // Pure red → Cr should be near max, Cb below 128.
        for pair in uv.chunks(2) {
            let cb = pair[0];
            let cr = pair[1];
            assert!(cb < 120, "expected Cb < 120 for red, got {cb}");
            assert!(cr > 180, "expected Cr > 180 for red, got {cr}");
        }
    }
}
