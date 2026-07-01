import path from 'path';
import webpack from 'webpack';
import type { Configuration } from 'webpack';
import grafanaConfig, { type Env } from './.config/webpack/webpack.config.ts';

const config = async (env: Env): Promise<Configuration> => {
  const baseConfig = await grafanaConfig(env);
  const zlibShimPath = path.resolve(process.cwd(), 'src', 'shims', 'nodeZlib.ts');
  return {
    ...baseConfig,
    cache:
      typeof baseConfig.cache === 'object'
        ? {
            ...baseConfig.cache,
            buildDependencies: {
              ...baseConfig.cache.buildDependencies,
              config: [
                ...((baseConfig.cache.buildDependencies?.config as string[] | undefined) ?? []),
                path.resolve(process.cwd(), 'webpack.config.ts'),
              ],
            },
          }
        : baseConfig.cache,
    resolve: {
      ...baseConfig.resolve,
      alias: {
        ...baseConfig.resolve?.alias,
        'node:zlib': zlibShimPath,
      },
    },
    plugins: [...(baseConfig.plugins ?? []), new webpack.NormalModuleReplacementPlugin(/^node:zlib$/, zlibShimPath)],
  };
};

export default config;
