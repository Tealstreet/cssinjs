import React from 'react';
import type Theme from '../theme/Theme';
import type { ExtractStyle } from './useGlobalCache';
export interface Option<DerivativeToken, DesignToken> {
    /**
     * Generate token with salt.
     * This is used to generate different hashId even same derivative token for different version.
     */
    salt?: string;
    override?: object;
    /**
     * Format token as you need. Such as:
     *
     * - rename token
     * - merge token
     * - delete token
     *
     * This should always be the same since it's one time process.
     * It's ok to useMemo outside but this has better cache strategy.
     */
    formatToken?: (mergedToken: any) => DerivativeToken;
    /**
     * Get final token with origin token, override token and theme.
     * The parameters do not contain formatToken since it's passed by user.
     * @param origin The original token.
     * @param override Extra tokens to override.
     * @param theme Theme instance. Could get derivative token by `theme.getDerivativeToken`
     */
    getComputedToken?: (origin: DesignToken, override: object, theme: Theme<any, any>) => DerivativeToken;
    /**
     * Transform token to css variables.
     */
    cssVar?: {
        /** Prefix for css variables */
        prefix?: string;
        /** Tokens that should not be appended with unit */
        unitless?: Record<string, boolean>;
        /** Tokens that should not be transformed to css variables */
        ignore?: Record<string, boolean>;
        /** Tokens that preserves origin value */
        preserve?: Record<string, boolean>;
        /** Key for current theme. Useful for customizing and should be unique */
        key?: string;
    };
}
export declare const getComputedToken: <DerivativeToken = object, DesignToken = DerivativeToken>(originToken: DesignToken, overrideToken: object, theme: Theme<any, any>, format?: ((token: DesignToken) => DerivativeToken) | undefined) => any;
export declare const TOKEN_PREFIX = "token";
type TokenCacheValue<DerivativeToken> = [
    token: DerivativeToken & {
        _tokenKey: string;
        _themeKey: string;
    },
    hashId: string,
    realToken: DerivativeToken & {
        _tokenKey: string;
    },
    cssVarStr: string,
    cssVarKey: string
];
export declare const extract: ExtractStyle<TokenCacheValue<any>>;
declare const _default: (...args: any[]) => any;
export default _default;
export declare const PollCacheToken: React.MemoExoticComponent<() => React.JSX.Element | null>;
