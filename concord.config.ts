import type { ProjectConfig } from 'concord-sdlc/config';

export default {
  "testRoots": [
    "internal",
    "web/src",
    "web/tests",
    "update-worker/test"
  ],
  "sourceRoots": [
    "internal",
    "cmd",
    "scripts",
    "web/src",
    "update-worker/src"
  ]
} as const satisfies ProjectConfig;
