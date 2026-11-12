import { expect } from 'chai';
import ID3TrackController from '../../../src/controller/id3-track-controller';
import Hls from '../../../src/hls';
import { Events } from '../../../src/events';
import { MetadataSchema } from '../../../src/types/demuxer';

describe('TimelineController', function () {
  let id3TrackController;
  let hls;
  let videoElement;

  beforeEach(function () {
    videoElement = document.createElement('video');
    hls = new Hls({ enableID3MetadataCues: true });
    id3TrackController = new ID3TrackController(hls);
    id3TrackController.media = videoElement;
  });

  // Encode an unsigned integer using ID3v2 synchsafe (7 bits per byte) encoding
  function syncSafeSize(size) {
    return [
      (size >> 21) & 0x7f,
      (size >> 14) & 0x7f,
      (size >> 7) & 0x7f,
      size & 0x7f,
    ];
  }

  // Build a minimal ID3v2.3 tag containing a single TXXX text frame so it is
  // decoded by getId3Frames without being treated as a timestamp frame
  function createId3Tag(description, value) {
    const encoder = new TextEncoder();
    // Encoding byte 0x03 (UTF-8) + description + NUL + value.
    // Use Array.from rather than spreading a Uint8Array since the test bundle
    // transpiles typed-array spread into a lossy sequence expansion.
    const frameData = [
      0x03,
      ...Array.from(encoder.encode(description)),
      0x00,
      ...Array.from(encoder.encode(value)),
    ];
    const frameHeader = [
      ...Array.from(encoder.encode('TXXX')),
      ...syncSafeSize(frameData.length),
      0x00,
      0x00,
    ];
    const frames = [...frameHeader, ...frameData];
    const header = [
      ...Array.from(encoder.encode('ID3')),
      0x03,
      0x00,
      0x00,
      ...syncSafeSize(frames.length),
    ];
    return new Uint8Array([...header, ...frames]);
  }

  function metadataSample(pts, tag) {
    return {
      pts,
      dts: pts,
      duration: 0.1,
      data: tag,
      type: MetadataSchema.audioId3,
    };
  }

  function appendCue(pts, description = 'ad', value = 'cue-marker') {
    id3TrackController.onFragParsingMetadata(Events.FRAG_PARSING_METADATA, {
      samples: [metadataSample(pts, createId3Tag(description, value))],
    });
  }

  // Emulate Safari stripping the custom expando fields from a native cue
  // while leaving the cue entry itself in the TextTrack
  function stripNativeCueFields(cue) {
    delete cue.value;
    delete cue.type;
  }

  describe('createCaptionsTrack', function () {
    it('should create new TextTrack in onFragParsingMetadata() and remove it in onMediaDetaching()', function () {
      expect(videoElement.textTracks.length).to.equal(0);
      id3TrackController.onFragParsingMetadata(Events.FRAG_PARSING_METADATA, {
        samples: [],
      });
      expect(videoElement.textTracks.length).to.equal(1);
      id3TrackController.onMediaDetaching(Events.MEDIA_DETACHING, {});
      expect(videoElement.textTracks.length).to.equal(0);
    });
  });

  describe('metadata cue retention', function () {
    it('retains a snapshot of every appended metadata cue with its data', function () {
      appendCue(0);
      appendCue(5);

      const track = id3TrackController.id3Track.track;
      expect(track.cues.length).to.equal(2);
      expect(id3TrackController.metadataCues.length).to.equal(2);

      const retained = id3TrackController.metadataCues[0];
      expect(retained.cue).to.equal(track.cues[0]);
      expect(retained.type).to.equal(MetadataSchema.audioId3);
      expect(retained.startTime).to.equal(0);
      expect(retained.value.key).to.equal('TXXX');
      expect(retained.value.info).to.equal('ad');
      expect(retained.value.data).to.equal('cue-marker');
    });

    it('keeps cue data available through retained snapshots after Safari empties the native cue fields', function () {
      appendCue(0, 'ad', 'marker-1');
      appendCue(5, 'ad', 'marker-2');

      const track = id3TrackController.id3Track.track;
      // Safari leaves the cue entries in place but blanks their custom fields
      stripNativeCueFields(track.cues[0]);
      stripNativeCueFields(track.cues[1]);

      // The number of entries on the track is unchanged
      expect(track.cues.length).to.equal(2);
      expect(track.cues[0].value).to.equal(undefined);
      expect(track.cues[1].type).to.equal(undefined);

      // Retained snapshots still expose the full ad marker payload
      const retained = id3TrackController.metadataCues;
      expect(retained.length).to.equal(2);
      expect(retained[0].value.data).to.equal('marker-1');
      expect(retained[0].type).to.equal(MetadataSchema.audioId3);
      expect(retained[1].value.data).to.equal('marker-2');
      expect(retained[1].type).to.equal(MetadataSchema.audioId3);
    });

    it('stores cue payload independently from the native cue object', function () {
      appendCue(0, 'ad', 'marker-1');

      const nativeCue = id3TrackController.id3Track.track.cues[0];
      const retained = id3TrackController.metadataCues[0];
      expect(retained.cue).to.equal(nativeCue);

      // Mutating the native cue must not affect the retained snapshot
      nativeCue.value = null;
      nativeCue.type = undefined;
      expect(retained.value.data).to.equal('marker-1');
      expect(retained.type).to.equal(MetadataSchema.audioId3);
    });

    it('retires retained snapshots in sync with back-buffer flushing', function () {
      appendCue(0, 'ad', 'old');
      appendCue(10, 'ad', 'recent');

      const track = id3TrackController.id3Track.track;
      expect(track.cues.length).to.equal(2);

      id3TrackController.onBufferFlushing(Events.BUFFER_FLUSHING, {
        startOffset: 0,
        endOffset: 9,
        type: 'audio',
      });

      // Only the cue inside the flushed range is removed, from both places
      expect(track.cues.length).to.equal(1);
      expect(track.cues[0].startTime).to.equal(10);
      expect(id3TrackController.metadataCues.length).to.equal(1);
      expect(id3TrackController.metadataCues[0].cue).to.equal(track.cues[0]);
      expect(id3TrackController.metadataCues[0].value.data).to.equal('recent');
    });

    it('clears retained snapshots when the media is detached', function () {
      appendCue(0);
      expect(id3TrackController.metadataCues.length).to.equal(1);

      id3TrackController.onMediaDetaching(Events.MEDIA_DETACHING, {});
      expect(id3TrackController.metadataCues.length).to.equal(0);
    });

    it('keeps retained snapshots across a media transfer', function () {
      appendCue(0);
      expect(id3TrackController.metadataCues.length).to.equal(1);

      id3TrackController.onMediaDetaching(Events.MEDIA_DETACHING, {
        transferMedia: true,
      });
      expect(id3TrackController.metadataCues.length).to.equal(1);
    });
  });
});
