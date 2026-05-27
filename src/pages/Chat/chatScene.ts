import { EmbeddedScene, SceneFlexItem, SceneFlexLayout } from '@grafana/scenes';
import { ChatSceneObject } from './ChatSceneObject';

export function chatScene() {
  return new EmbeddedScene({
    body: new SceneFlexLayout({
      direction: 'column',
      children: [
        new SceneFlexItem({
          ySizing: 'fill',
          body: new ChatSceneObject({}),
        }),
      ],
    }),
  });
}
