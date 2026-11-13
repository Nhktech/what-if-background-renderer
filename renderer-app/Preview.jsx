import React from 'react';
import { Player } from '@remotion/player';

export default function Preview({ VideoComponent, compositionConfig }) {
  const config = compositionConfig || {};

  const fps = config.fps || 30;
  const width = config.width || 1920;
  const height = config.height || 1080;

  const durationInFrames =
    config.durationInFrames ||
    Math.round((config.durationInSeconds || 5) * fps);

  return (
    <div
      style={{
        width: '100%',
        aspectRatio: `${width} / ${height}`,
        position: 'relative',
        overflow: 'hidden',
        backgroundColor: '#000',
      }}
    >
      <Player
        component={VideoComponent}
        durationInFrames={durationInFrames}
        compositionWidth={width}
        compositionHeight={height}
        fps={fps}
        controls
        style={{
          width: '100%',
          height: '100%',
        }}
      />
    </div>
  );
}
