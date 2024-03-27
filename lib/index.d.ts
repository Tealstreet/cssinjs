import extractStyle from './extractStyle';
import useCacheToken, { getComputedToken, PollCacheToken } from './hooks/useCacheToken';
import useCSSVarRegister from './hooks/useCSSVarRegister';
import type { CSSInterpolation, CSSObject } from './hooks/useStyleRegister';
import useStyleRegister from './hooks/useStyleRegister';
import Keyframes from './Keyframes';
import type { Linter } from './linters';
import { legacyNotSelectorLinter, logicalPropertiesLinter, NaNLinter, parentSelectorLinter } from './linters';
import type { StyleProviderProps } from './StyleContext';
import { createCache, StyleProvider } from './StyleContext';
import type { DerivativeFunc, TokenType } from './theme';
import { createTheme, Theme } from './theme';
import type { Transformer } from './transformers/interface';
import legacyLogicalPropertiesTransformer from './transformers/legacyLogicalProperties';
import px2remTransformer from './transformers/px2rem';
import { unit } from './util';
import { token2CSSVar } from './util/css-variables';
export { Theme, createTheme, useStyleRegister, useCSSVarRegister, useCacheToken, createCache, StyleProvider, Keyframes, extractStyle, getComputedToken, PollCacheToken, legacyLogicalPropertiesTransformer, px2remTransformer, logicalPropertiesLinter, legacyNotSelectorLinter, parentSelectorLinter, NaNLinter, token2CSSVar, unit, };
export type { TokenType, CSSObject, CSSInterpolation, DerivativeFunc, Transformer, Linter, StyleProviderProps, };
export declare const _experimental: {
    supportModernCSS: () => boolean;
};
