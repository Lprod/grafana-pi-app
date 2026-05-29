import { SceneAppPage } from '@grafana/scenes';
import { ROUTES } from '../../constants';
import { prefixRoute } from '../../utils/utils.routing';
import { chatScene } from './chatScene';

export const chatPage = new SceneAppPage({
  title: 'Observability Analyst',
  subTitle: 'Investigate metrics, validate PromQL, and create reviewable dashboards in this Grafana org.',
  url: prefixRoute(ROUTES.Chat),
  routePath: ROUTES.Chat,
  getScene: chatScene,
});
