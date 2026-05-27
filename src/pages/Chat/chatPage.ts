import { SceneAppPage } from '@grafana/scenes';
import { ROUTES } from '../../constants';
import { prefixRoute } from '../../utils/utils.routing';
import { chatScene } from './chatScene';

export const chatPage = new SceneAppPage({
  title: 'Pi Assistant',
  subTitle: 'Ask questions about metrics, queries, and dashboards in this Grafana org.',
  url: prefixRoute(ROUTES.Chat),
  routePath: ROUTES.Chat,
  getScene: chatScene,
});
