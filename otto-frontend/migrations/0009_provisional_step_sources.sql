ALTER TABLE provisional_steps
  DROP CONSTRAINT IF EXISTS provisional_steps_source_check;

ALTER TABLE provisional_steps
  ADD CONSTRAINT provisional_steps_source_check
  CHECK (
    source IN (
      'live_segmenter',
      'live_screen_segmenter',
      'screen_vision_segmenter',
      'operator_tool',
      'video_segmenter',
      'document_hypothesis'
    )
  );
