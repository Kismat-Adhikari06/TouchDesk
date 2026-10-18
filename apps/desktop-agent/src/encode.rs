use openh264::OpenH264API;
use openh264::encoder::{
    BitRate, Complexity, Encoder, EncoderConfig, FrameRate, FrameType, IntraFramePeriod, Level,
    Profile, RateControlMode, SpsPpsStrategy, UsageType, VuiConfig,
};
use openh264::formats::{RgbaSliceU8, YUVBuffer};

/// One encoded H.264 access unit in Annex B format (start-code prefixed NALs).
pub struct EncodedFrame {
    pub data: Vec<u8>,
}

pub struct H264Encoder {
    encoder: Encoder,
    scratch: Vec<u8>,
}

impl H264Encoder {
    pub fn new(bitrate_bps: u32, fps: u32) -> anyhow::Result<Self> {
        let config = EncoderConfig::new()
            .bitrate(BitRate::from_bps(bitrate_bps))
            .max_frame_rate(FrameRate::from_hz(fps as f32))
            .rate_control_mode(RateControlMode::Bitrate)
            .usage_type(UsageType::ScreenContentRealTime)
            .complexity(Complexity::Low)
            .num_threads(2)
            .profile(Profile::Baseline)
            .level(Level::Level_4_0)
            .sps_pps_strategy(SpsPpsStrategy::IncreasingId)
            .intra_frame_period(IntraFramePeriod::from_num_frames(fps * 2))
            .vui(VuiConfig::srgb());
        let encoder = Encoder::with_api_config(OpenH264API::from_source(), config)?;
        Ok(Self {
            encoder,
            scratch: Vec::with_capacity(1 << 17),
        })
    }

    /// Encodes an RGBA frame. Width/height must be even. Returns `None` when the
    /// encoder skipped the frame (rate control), which is normal under load.
    pub fn encode_rgba(
        &mut self,
        rgba: &[u8],
        width: usize,
        height: usize,
    ) -> anyhow::Result<Option<EncodedFrame>> {
        let source = RgbaSliceU8::new(rgba, (width, height));
        let yuv = YUVBuffer::from_rgb_source(source);
        let bitstream = self.encoder.encode(&yuv)?;

        if bitstream.frame_type() == FrameType::Skip {
            return Ok(None);
        }

        self.scratch.clear();
        write_annexb(&bitstream, &mut self.scratch);
        if self.scratch.is_empty() {
            return Ok(None);
        }

        Ok(Some(EncodedFrame {
            data: std::mem::take(&mut self.scratch),
        }))
    }

    pub fn force_keyframe(&mut self) {
        self.encoder.force_intra_frame();
    }
}

/// Serializes the encoder output as Annex B, adding start codes if the encoder
/// did not include them.
fn write_annexb(bitstream: &openh264::encoder::EncodedBitStream<'_>, out: &mut Vec<u8>) {
    for layer_idx in 0..bitstream.num_layers() {
        let Some(layer) = bitstream.layer(layer_idx) else {
            continue;
        };
        for nal_idx in 0..layer.nal_count() {
            let Some(nal) = layer.nal_unit(nal_idx) else {
                continue;
            };
            let has_start_code = nal.len() >= 3
                && nal[0] == 0
                && nal[1] == 0
                && (nal[2] == 1 || (nal.len() >= 4 && nal[2] == 0 && nal[3] == 1));
            if !has_start_code {
                out.extend_from_slice(&[0, 0, 0, 1]);
            }
            out.extend_from_slice(nal);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn find_nal_type(data: &[u8], wanted: u8) -> bool {
        let mut i = 0;
        while i + 4 < data.len() {
            if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 0 && data[i + 3] == 1 {
                let nal_type = data[i + 4] & 0x1f;
                if nal_type == wanted {
                    return true;
                }
                i += 4;
            } else if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
                let nal_type = data[i + 3] & 0x1f;
                if nal_type == wanted {
                    return true;
                }
                i += 3;
            } else {
                i += 1;
            }
        }
        false
    }

    fn gradient_frame(width: usize, height: usize) -> Vec<u8> {
        let mut rgba = vec![0u8; width * height * 4];
        for y in 0..height {
            for x in 0..width {
                let i = (y * width + x) * 4;
                rgba[i] = (x % 256) as u8;
                rgba[i + 1] = (y % 256) as u8;
                rgba[i + 2] = ((x + y) % 256) as u8;
                rgba[i + 3] = 255;
            }
        }
        rgba
    }

    #[test]
    fn encodes_synthetic_frames_to_annexb_with_parameter_sets() {
        let mut encoder = H264Encoder::new(2_000_000, 30).expect("encoder creation");
        let (width, height) = (640, 360);
        let rgba = gradient_frame(width, height);

        let mut first: Option<EncodedFrame> = None;
        let mut frames = 0;
        for _ in 0..10 {
            if let Some(frame) = encoder
                .encode_rgba(&rgba, width, height)
                .expect("encode frame")
            {
                if first.is_none() {
                    first = Some(frame);
                }
                frames += 1;
            }
        }

        let first = first.expect("first frames must encode");
        assert!(
            first.data.starts_with(&[0, 0, 0, 1]) || first.data.starts_with(&[0, 0, 1]),
            "bitstream must be Annex B prefixed"
        );
        assert!(find_nal_type(&first.data, 7), "missing SPS NAL");
        assert!(find_nal_type(&first.data, 8), "missing PPS NAL");
        assert!(find_nal_type(&first.data, 5), "missing IDR slice NAL");
        assert!(frames >= 1);
    }

    #[test]
    fn downscale_targets_are_even_and_capped() {
        let (src_w, src_h, max_w) = (1919u32, 1079u32, 1280u32);
        let scale = (max_w as f32 / src_w as f32).min(1.0);
        let tw = (((src_w as f32 * scale) as u32) & !1).max(2);
        let th = (((src_h as f32 * scale) as u32) & !1).max(2);
        assert_eq!(tw % 2, 0);
        assert_eq!(th % 2, 0);
        assert!(tw <= max_w);
        assert!(tw <= src_w);
    }
}
