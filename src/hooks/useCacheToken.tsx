import hash from '@emotion/hash';
import { updateCSS } from 'rc-util/lib/Dom/dynamicCSS';
import React, { useContext, useEffect, useState } from 'react';
import StyleContext, {
  ATTR_MARK,
  ATTR_TOKEN,
  CSS_IN_JS_INSTANCE,
} from '../StyleContext';
import type Theme from '../theme/Theme';
import { flattenToken, memoResult, token2key, toStyleStr } from '../util';
import { transformToken } from '../util/css-variables';
import type { ExtractStyle } from './useGlobalCache';
import useGlobalCache from './useGlobalCache';

const EMPTY_OVERRIDE = {};

// Generate different prefix to make user selector break in production env.
// This helps developer not to do style override directly on the hash id.
const hashPrefix =
  process.env.NODE_ENV !== 'production'
    ? 'css-dev-only-do-not-override'
    : 'css';

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
  getComputedToken?: (
    origin: DesignToken,
    override: object,
    theme: Theme<any, any>,
  ) => DerivativeToken;

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

const tokenKeys = new Map<string, number>();
function recordCleanToken(tokenKey: string) {
  tokenKeys.set(tokenKey, (tokenKeys.get(tokenKey) || 0) + 1);
}

function removeStyleTags(key: string, instanceId: string) {
  if (typeof document !== 'undefined') {
    const styles = document.querySelectorAll(`style[${ATTR_TOKEN}="${key}"]`);

    styles.forEach((style) => {
      if ((style as any)[CSS_IN_JS_INSTANCE] === instanceId) {
        style.parentNode?.removeChild(style);
      }
    });
  }
}

const TOKEN_THRESHOLD = 0;

// Remove will check current keys first
function cleanTokenStyle(tokenKey: string, instanceId: string) {
  tokenKeys.set(tokenKey, (tokenKeys.get(tokenKey) || 0) - 1);

  const tokenKeyList = Array.from(tokenKeys.keys());
  const cleanableKeyList = tokenKeyList.filter((key) => {
    const count = tokenKeys.get(key) || 0;

    return count <= 0;
  });

  // Should keep tokens under threshold for not to insert style too often
  if (tokenKeyList.length - cleanableKeyList.length > TOKEN_THRESHOLD) {
    cleanableKeyList.forEach((key) => {
      removeStyleTags(key, instanceId);
      tokenKeys.delete(key);
    });
  }
}

export const getComputedToken = <
  DerivativeToken = object,
  DesignToken = DerivativeToken,
>(
  originToken: DesignToken,
  overrideToken: object,
  theme: Theme<any, any>,
  format?: (token: DesignToken) => DerivativeToken,
) => {
  const derivativeToken = theme.getDerivativeToken(originToken);

  // Merge with override
  let mergedDerivativeToken = {
    ...derivativeToken,
    ...overrideToken,
  };

  // Format if needed
  if (format) {
    mergedDerivativeToken = format(mergedDerivativeToken);
  }

  return mergedDerivativeToken;
};

export const TOKEN_PREFIX = 'token';

type TokenCacheValue<DerivativeToken> = [
  token: DerivativeToken & { _tokenKey: string; _themeKey: string },
  hashId: string,
  realToken: DerivativeToken & { _tokenKey: string },
  cssVarStr: string,
  cssVarKey: string,
];

/**
 * Cache theme derivative token as global shared one
 * @param theme Theme entity
 * @param tokens List of tokens, used for cache. Please do not dynamic generate object directly
 * @param option Additional config
 * @returns Call Theme.getDerivativeToken(tokenObject) to get token
 */
function useCacheTokenHelper<
  DerivativeToken = object,
  DesignToken = DerivativeToken,
>(
  theme: Theme<any, any>,
  tokens: Partial<DesignToken>[],
  option: Option<DerivativeToken, DesignToken> = {},
): TokenCacheValue<DerivativeToken> {
  const {
    cache: { instanceId },
    container,
  } = useContext(StyleContext);
  const {
    salt = '',
    override = EMPTY_OVERRIDE,
    formatToken,
    getComputedToken: compute,
    cssVar,
  } = option;

  // Basic - We do basic cache here
  const mergedToken = memoResult(() => Object.assign({}, ...tokens), tokens);

  const tokenStr = flattenToken(mergedToken);
  const overrideTokenStr = flattenToken(override);

  const cssVarStr = cssVar ? flattenToken(cssVar) : '';

  const cachedToken = useGlobalCache<TokenCacheValue<DerivativeToken>>(
    TOKEN_PREFIX,
    [salt, theme.id, tokenStr, overrideTokenStr, cssVarStr],
    () => {
      let mergedDerivativeToken = compute
        ? compute(mergedToken, override, theme)
        : getComputedToken(mergedToken, override, theme, formatToken);

      // Replace token value with css variables
      const actualToken = { ...mergedDerivativeToken };
      let cssVarsStr = '';
      if (!!cssVar) {
        [mergedDerivativeToken, cssVarsStr] = transformToken(
          mergedDerivativeToken,
          cssVar.key!,
          {
            prefix: cssVar.prefix,
            ignore: cssVar.ignore,
            unitless: cssVar.unitless,
            preserve: cssVar.preserve,
          },
        );
      }

      // Optimize for `useStyleRegister` performance
      const tokenKey = token2key(mergedDerivativeToken, salt);
      mergedDerivativeToken._tokenKey = tokenKey;
      actualToken._tokenKey = token2key(actualToken, salt);

      const themeKey = cssVar?.key ?? tokenKey;
      mergedDerivativeToken._themeKey = themeKey;
      recordCleanToken(themeKey);

      const hashId = `${hashPrefix}-${hash(tokenKey)}`;
      mergedDerivativeToken._hashId = hashId; // Not used

      return [
        mergedDerivativeToken,
        hashId,
        actualToken,
        cssVarsStr,
        cssVar?.key || '',
      ];
    },
    (cache) => {
      // Remove token will remove all related style
      cleanTokenStyle(cache[0]._themeKey, instanceId);
    },
    ([token, , , cssVarsStr]) => {
      if (cssVar && cssVarsStr) {
        const style = updateCSS(
          cssVarsStr,
          hash(`css-variables-${token._themeKey}`),
          {
            mark: ATTR_MARK,
            prepend: 'queue',
            attachTo: container,
            priority: -999,
          },
        );

        (style as any)[CSS_IN_JS_INSTANCE] = instanceId;

        // Used for `useCacheToken` to remove on batch when token removed
        style.setAttribute(ATTR_TOKEN, token._themeKey);
      }
    },
  );

  return cachedToken;
}

export const extract: ExtractStyle<TokenCacheValue<any>> = (
  cache,
  effectStyles,
  options,
) => {
  const [, , realToken, styleStr, cssVarKey] = cache;
  const { plain } = options || {};

  if (!styleStr) {
    return null;
  }

  const styleId = realToken._tokenKey;
  const order = -999;

  // ====================== Style ======================
  // Used for rc-util
  const sharedAttrs = {
    'data-rc-order': 'prependQueue',
    'data-rc-priority': `${order}`,
  };

  const styleText = toStyleStr(
    styleStr,
    cssVarKey,
    styleId,
    sharedAttrs,
    plain,
  );

  return [order, styleId, styleText];
};

const rerenderTime = 1000;

let cacheArgs: any[] | null = null;
let setArgUpdate: any = null;

let cachedToken = [
  {
    blue: '#1677ff',
    purple: '#722ED1',
    cyan: '#13C2C2',
    green: '#52C41A',
    magenta: '#EB2F96',
    pink: '#eb2f96',
    red: '#F5222D',
    orange: '#FA8C16',
    yellow: '#FADB14',
    volcano: '#FA541C',
    geekblue: '#2F54EB',
    gold: '#FAAD14',
    lime: '#A0D911',
    colorPrimary: '#0c91bc',
    colorSuccess: '#49aa19',
    colorWarning: '#d89614',
    colorError: '#dc4446',
    colorInfo: '#1668dc',
    colorLink: '#1668dc',
    colorTextBase: '#fff',
    colorBgBase: '#23232e',
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    fontFamilyCode:
      "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, Courier, monospace",
    fontSize: 12,
    lineWidth: 1,
    lineType: 'solid',
    motionUnit: 0.1,
    motionBase: 0,
    motionEaseOutCirc: 'cubic-bezier(0.08, 0.82, 0.17, 1)',
    motionEaseInOutCirc: 'cubic-bezier(0.78, 0.14, 0.15, 0.86)',
    motionEaseOut: 'cubic-bezier(0.215, 0.61, 0.355, 1)',
    motionEaseInOut: 'cubic-bezier(0.645, 0.045, 0.355, 1)',
    motionEaseOutBack: 'cubic-bezier(0.12, 0.4, 0.29, 1.46)',
    motionEaseInBack: 'cubic-bezier(0.71, -0.46, 0.88, 0.6)',
    motionEaseInQuint: 'cubic-bezier(0.755, 0.05, 0.855, 0.06)',
    motionEaseOutQuint: 'cubic-bezier(0.23, 1, 0.32, 1)',
    borderRadius: 6,
    sizeUnit: 4,
    sizeStep: 4,
    sizePopupArrow: 16,
    controlHeight: 28,
    zIndexBase: 0,
    zIndexPopupBase: 1000,
    opacityImage: 1,
    wireframe: false,
    motion: false,
    colorText: '#ffffffa6',
    colorTextSecondary: '#ffffff73',
    colorTextDisabled: '#ffffff40',
    colorIcon: '#ffffffa6',
    colorIconHover: '#ffffffd9',
    colorBorder: '#17171f',
    fontSizeLG: 16,
    'blue-1': '#111a2c',
    blue1: '#111a2c',
    'blue-2': '#112545',
    blue2: '#112545',
    'blue-3': '#15325b',
    blue3: '#15325b',
    'blue-4': '#15417e',
    blue4: '#15417e',
    'blue-5': '#1554ad',
    blue5: '#1554ad',
    'blue-6': '#1668dc',
    blue6: '#1668dc',
    'blue-7': '#3c89e8',
    blue7: '#3c89e8',
    'blue-8': '#65a9f3',
    blue8: '#65a9f3',
    'blue-9': '#8dc5f8',
    blue9: '#8dc5f8',
    'blue-10': '#b7dcfa',
    blue10: '#b7dcfa',
    'purple-1': '#1a1325',
    purple1: '#1a1325',
    'purple-2': '#24163a',
    purple2: '#24163a',
    'purple-3': '#301c4d',
    purple3: '#301c4d',
    'purple-4': '#3e2069',
    purple4: '#3e2069',
    'purple-5': '#51258f',
    purple5: '#51258f',
    'purple-6': '#642ab5',
    purple6: '#642ab5',
    'purple-7': '#854eca',
    purple7: '#854eca',
    'purple-8': '#ab7ae0',
    purple8: '#ab7ae0',
    'purple-9': '#cda8f0',
    purple9: '#cda8f0',
    'purple-10': '#ebd7fa',
    purple10: '#ebd7fa',
    'cyan-1': '#112123',
    cyan1: '#112123',
    'cyan-2': '#113536',
    cyan2: '#113536',
    'cyan-3': '#144848',
    cyan3: '#144848',
    'cyan-4': '#146262',
    cyan4: '#146262',
    'cyan-5': '#138585',
    cyan5: '#138585',
    'cyan-6': '#13a8a8',
    cyan6: '#13a8a8',
    'cyan-7': '#33bcb7',
    cyan7: '#33bcb7',
    'cyan-8': '#58d1c9',
    cyan8: '#58d1c9',
    'cyan-9': '#84e2d8',
    cyan9: '#84e2d8',
    'cyan-10': '#b2f1e8',
    cyan10: '#b2f1e8',
    'green-1': '#162312',
    green1: '#162312',
    'green-2': '#1d3712',
    green2: '#1d3712',
    'green-3': '#274916',
    green3: '#274916',
    'green-4': '#306317',
    green4: '#306317',
    'green-5': '#3c8618',
    green5: '#3c8618',
    'green-6': '#49aa19',
    green6: '#49aa19',
    'green-7': '#6abe39',
    green7: '#6abe39',
    'green-8': '#8fd460',
    green8: '#8fd460',
    'green-9': '#b2e58b',
    green9: '#b2e58b',
    'green-10': '#d5f2bb',
    green10: '#d5f2bb',
    'magenta-1': '#291321',
    magenta1: '#291321',
    'magenta-2': '#40162f',
    magenta2: '#40162f',
    'magenta-3': '#551c3b',
    magenta3: '#551c3b',
    'magenta-4': '#75204f',
    magenta4: '#75204f',
    'magenta-5': '#a02669',
    magenta5: '#a02669',
    'magenta-6': '#cb2b83',
    magenta6: '#cb2b83',
    'magenta-7': '#e0529c',
    magenta7: '#e0529c',
    'magenta-8': '#f37fb7',
    magenta8: '#f37fb7',
    'magenta-9': '#f8a8cc',
    magenta9: '#f8a8cc',
    'magenta-10': '#fad2e3',
    magenta10: '#fad2e3',
    'pink-1': '#291321',
    pink1: '#291321',
    'pink-2': '#40162f',
    pink2: '#40162f',
    'pink-3': '#551c3b',
    pink3: '#551c3b',
    'pink-4': '#75204f',
    pink4: '#75204f',
    'pink-5': '#a02669',
    pink5: '#a02669',
    'pink-6': '#cb2b83',
    pink6: '#cb2b83',
    'pink-7': '#e0529c',
    pink7: '#e0529c',
    'pink-8': '#f37fb7',
    pink8: '#f37fb7',
    'pink-9': '#f8a8cc',
    pink9: '#f8a8cc',
    'pink-10': '#fad2e3',
    pink10: '#fad2e3',
    'red-1': '#2a1215',
    red1: '#2a1215',
    'red-2': '#431418',
    red2: '#431418',
    'red-3': '#58181c',
    red3: '#58181c',
    'red-4': '#791a1f',
    red4: '#791a1f',
    'red-5': '#a61d24',
    red5: '#a61d24',
    'red-6': '#d32029',
    red6: '#d32029',
    'red-7': '#e84749',
    red7: '#e84749',
    'red-8': '#f37370',
    red8: '#f37370',
    'red-9': '#f89f9a',
    red9: '#f89f9a',
    'red-10': '#fac8c3',
    red10: '#fac8c3',
    'orange-1': '#2b1d11',
    orange1: '#2b1d11',
    'orange-2': '#442a11',
    orange2: '#442a11',
    'orange-3': '#593815',
    orange3: '#593815',
    'orange-4': '#7c4a15',
    orange4: '#7c4a15',
    'orange-5': '#aa6215',
    orange5: '#aa6215',
    'orange-6': '#d87a16',
    orange6: '#d87a16',
    'orange-7': '#e89a3c',
    orange7: '#e89a3c',
    'orange-8': '#f3b765',
    orange8: '#f3b765',
    'orange-9': '#f8cf8d',
    orange9: '#f8cf8d',
    'orange-10': '#fae3b7',
    orange10: '#fae3b7',
    'yellow-1': '#2b2611',
    yellow1: '#2b2611',
    'yellow-2': '#443b11',
    yellow2: '#443b11',
    'yellow-3': '#595014',
    yellow3: '#595014',
    'yellow-4': '#7c6e14',
    yellow4: '#7c6e14',
    'yellow-5': '#aa9514',
    yellow5: '#aa9514',
    'yellow-6': '#d8bd14',
    yellow6: '#d8bd14',
    'yellow-7': '#e8d639',
    yellow7: '#e8d639',
    'yellow-8': '#f3ea62',
    yellow8: '#f3ea62',
    'yellow-9': '#f8f48b',
    yellow9: '#f8f48b',
    'yellow-10': '#fafab5',
    yellow10: '#fafab5',
    'volcano-1': '#2b1611',
    volcano1: '#2b1611',
    'volcano-2': '#441d12',
    volcano2: '#441d12',
    'volcano-3': '#592716',
    volcano3: '#592716',
    'volcano-4': '#7c3118',
    volcano4: '#7c3118',
    'volcano-5': '#aa3e19',
    volcano5: '#aa3e19',
    'volcano-6': '#d84a1b',
    volcano6: '#d84a1b',
    'volcano-7': '#e87040',
    volcano7: '#e87040',
    'volcano-8': '#f3956a',
    volcano8: '#f3956a',
    'volcano-9': '#f8b692',
    volcano9: '#f8b692',
    'volcano-10': '#fad4bc',
    volcano10: '#fad4bc',
    'geekblue-1': '#131629',
    geekblue1: '#131629',
    'geekblue-2': '#161d40',
    geekblue2: '#161d40',
    'geekblue-3': '#1c2755',
    geekblue3: '#1c2755',
    'geekblue-4': '#203175',
    geekblue4: '#203175',
    'geekblue-5': '#263ea0',
    geekblue5: '#263ea0',
    'geekblue-6': '#2b4acb',
    geekblue6: '#2b4acb',
    'geekblue-7': '#5273e0',
    geekblue7: '#5273e0',
    'geekblue-8': '#7f9ef3',
    geekblue8: '#7f9ef3',
    'geekblue-9': '#a8c1f8',
    geekblue9: '#a8c1f8',
    'geekblue-10': '#d2e0fa',
    geekblue10: '#d2e0fa',
    'gold-1': '#2b2111',
    gold1: '#2b2111',
    'gold-2': '#443111',
    gold2: '#443111',
    'gold-3': '#594214',
    gold3: '#594214',
    'gold-4': '#7c5914',
    gold4: '#7c5914',
    'gold-5': '#aa7714',
    gold5: '#aa7714',
    'gold-6': '#d89614',
    gold6: '#d89614',
    'gold-7': '#e8b339',
    gold7: '#e8b339',
    'gold-8': '#f3cc62',
    gold8: '#f3cc62',
    'gold-9': '#f8df8b',
    gold9: '#f8df8b',
    'gold-10': '#faedb5',
    gold10: '#faedb5',
    'lime-1': '#1f2611',
    lime1: '#1f2611',
    'lime-2': '#2e3c10',
    lime2: '#2e3c10',
    'lime-3': '#3e4f13',
    lime3: '#3e4f13',
    'lime-4': '#536d13',
    lime4: '#536d13',
    'lime-5': '#6f9412',
    lime5: '#6f9412',
    'lime-6': '#8bbb11',
    lime6: '#8bbb11',
    'lime-7': '#a9d134',
    lime7: '#a9d134',
    'lime-8': '#c9e75d',
    lime8: '#c9e75d',
    'lime-9': '#e4f88b',
    lime9: '#e4f88b',
    'lime-10': '#f0fab5',
    lime10: '#f0fab5',
    colorTextTertiary: 'rgba(255, 255, 255, 0.45)',
    colorTextQuaternary: 'rgba(255, 255, 255, 0.25)',
    colorFill: 'rgba(255, 255, 255, 0.18)',
    colorFillSecondary: 'rgba(255, 255, 255, 0.12)',
    colorFillTertiary: 'rgba(255, 255, 255, 0.08)',
    colorFillQuaternary: 'rgba(255, 255, 255, 0.04)',
    colorBgLayout: '#23232e',
    colorBgContainer: '#353545',
    colorBgElevated: '#3d3d51',
    colorBgSpotlight: '#5c5c79',
    colorBgBlur: 'rgba(255, 255, 255, 0.04)',
    colorBorderSecondary: '#4d4d65',
    colorPrimaryBg: '#111f26',
    colorPrimaryBgHover: '#0f2f3c',
    colorPrimaryBorder: '#11404f',
    colorPrimaryBorderHover: '#10566d',
    colorPrimaryHover: '#2dadd1',
    colorPrimaryActive: '#0e7495',
    colorPrimaryTextHover: '#2dadd1',
    colorPrimaryText: '#0c91bc',
    colorPrimaryTextActive: '#0e7495',
    colorSuccessBg: '#162312',
    colorSuccessBgHover: '#1d3712',
    colorSuccessBorder: '#274916',
    colorSuccessBorderHover: '#306317',
    colorSuccessHover: '#306317',
    colorSuccessActive: '#3c8618',
    colorSuccessTextHover: '#6abe39',
    colorSuccessText: '#49aa19',
    colorSuccessTextActive: '#3c8618',
    colorErrorBg: '#2c1618',
    colorErrorBgHover: '#451d1f',
    colorErrorBorder: '#5b2526',
    colorErrorBorderHover: '#7e2e2f',
    colorErrorHover: '#e86e6b',
    colorErrorActive: '#ad393a',
    colorErrorTextHover: '#e86e6b',
    colorErrorText: '#dc4446',
    colorErrorTextActive: '#ad393a',
    colorWarningBg: '#2b2111',
    colorWarningBgHover: '#443111',
    colorWarningBorder: '#594214',
    colorWarningBorderHover: '#7c5914',
    colorWarningHover: '#7c5914',
    colorWarningActive: '#aa7714',
    colorWarningTextHover: '#e8b339',
    colorWarningText: '#d89614',
    colorWarningTextActive: '#aa7714',
    colorInfoBg: '#111a2c',
    colorInfoBgHover: '#112545',
    colorInfoBorder: '#15325b',
    colorInfoBorderHover: '#15417e',
    colorInfoHover: '#15417e',
    colorInfoActive: '#1554ad',
    colorInfoTextHover: '#3c89e8',
    colorInfoText: '#1668dc',
    colorInfoTextActive: '#1554ad',
    colorLinkHover: '#15417e',
    colorLinkActive: '#1554ad',
    colorBgMask: 'rgba(0, 0, 0, 0.45)',
    colorWhite: '#fff',
    fontSizeSM: 10,
    fontSizeXL: 16,
    fontSizeHeading1: 32,
    fontSizeHeading2: 26,
    fontSizeHeading3: 20,
    fontSizeHeading4: 16,
    fontSizeHeading5: 14,
    lineHeight: 1.6666666666666667,
    lineHeightLG: 1.5714285714285714,
    lineHeightSM: 1.8,
    fontHeight: 20,
    fontHeightLG: 22,
    fontHeightSM: 18,
    lineHeightHeading1: 1.25,
    lineHeightHeading2: 1.3076923076923077,
    lineHeightHeading3: 1.4,
    lineHeightHeading4: 1.5,
    lineHeightHeading5: 1.5714285714285714,
    sizeXXL: 48,
    sizeXL: 32,
    sizeLG: 16,
    sizeMD: 16,
    sizeMS: 12,
    size: 8,
    sizeSM: 8,
    sizeXS: 4,
    sizeXXS: 4,
    controlHeightSM: 21,
    controlHeightXS: 14,
    controlHeightLG: 35,
    motionDurationFast: '0s',
    motionDurationMid: '0s',
    motionDurationSlow: '0s',
    lineWidthBold: 2,
    borderRadiusXS: 2,
    borderRadiusSM: 4,
    borderRadiusLG: 8,
    borderRadiusOuter: 4,
    colorFillContent: 'rgba(255, 255, 255, 0.12)',
    colorFillContentHover: 'rgba(255, 255, 255, 0.18)',
    colorFillAlter: 'rgba(255, 255, 255, 0.04)',
    colorBgContainerDisabled: 'rgba(255, 255, 255, 0.08)',
    colorBorderBg: '#353545',
    colorSplit: 'rgba(186, 186, 247, 0.18)',
    colorTextPlaceholder: 'rgba(255, 255, 255, 0.25)',
    colorTextHeading: '#ffffffa6',
    colorTextLabel: '#ffffff73',
    colorTextDescription: 'rgba(255, 255, 255, 0.45)',
    colorTextLightSolid: '#fff',
    colorHighlight: '#dc4446',
    colorBgTextHover: 'rgba(255, 255, 255, 0.12)',
    colorBgTextActive: 'rgba(255, 255, 255, 0.18)',
    colorErrorOutline: 'rgba(39, 5, 0, 0.65)',
    colorWarningOutline: 'rgba(40, 26, 0, 0.75)',
    fontSizeIcon: 10,
    lineWidthFocus: 4,
    controlOutlineWidth: 2,
    controlInteractiveSize: 14,
    controlItemBgHover: 'rgba(255, 255, 255, 0.08)',
    controlItemBgActive: '#111f26',
    controlItemBgActiveHover: '#0f2f3c',
    controlItemBgActiveDisabled: 'rgba(255, 255, 255, 0.18)',
    controlTmpOutline: 'rgba(255, 255, 255, 0.04)',
    controlOutline: 'rgba(0, 21, 23, 0.68)',
    fontWeightStrong: 600,
    opacityLoading: 0.65,
    linkDecoration: 'none',
    linkHoverDecoration: 'none',
    linkFocusDecoration: 'none',
    controlPaddingHorizontal: 12,
    controlPaddingHorizontalSM: 8,
    paddingXXS: 4,
    paddingXS: 4,
    paddingSM: 8,
    padding: 8,
    paddingMD: 16,
    paddingLG: 16,
    paddingXL: 32,
    paddingContentHorizontalLG: 16,
    paddingContentVerticalLG: 12,
    paddingContentHorizontal: 12,
    paddingContentVertical: 8,
    paddingContentHorizontalSM: 8,
    paddingContentVerticalSM: 4,
    marginXXS: 4,
    marginXS: 4,
    marginSM: 8,
    margin: 8,
    marginMD: 16,
    marginLG: 16,
    marginXL: 32,
    marginXXL: 48,
    boxShadow:
      '\n      0 6px 16px 0 rgba(0, 0, 0, 0.08),\n      0 3px 6px -4px rgba(0, 0, 0, 0.12),\n      0 9px 28px 8px rgba(0, 0, 0, 0.05)\n    ',
    boxShadowSecondary:
      '\n      0 6px 16px 0 rgba(0, 0, 0, 0.08),\n      0 3px 6px -4px rgba(0, 0, 0, 0.12),\n      0 9px 28px 8px rgba(0, 0, 0, 0.05)\n    ',
    boxShadowTertiary:
      '\n      0 1px 2px 0 rgba(0, 0, 0, 0.03),\n      0 1px 6px -1px rgba(0, 0, 0, 0.02),\n      0 2px 4px 0 rgba(0, 0, 0, 0.02)\n    ',
    screenXS: 480,
    screenXSMin: 480,
    screenXSMax: 575,
    screenSM: 576,
    screenSMMin: 576,
    screenSMMax: 767,
    screenMD: 768,
    screenMDMin: 768,
    screenMDMax: 991,
    screenLG: 992,
    screenLGMin: 992,
    screenLGMax: 1199,
    screenXL: 1200,
    screenXLMin: 1200,
    screenXLMax: 1599,
    screenXXL: 1600,
    screenXXLMin: 1600,
    boxShadowPopoverArrow: '2px 2px 5px rgba(0, 0, 0, 0.05)',
    boxShadowCard:
      '\n      0 1px 2px -2px rgba(0, 0, 0, 0.16),\n      0 3px 6px 0 rgba(0, 0, 0, 0.12),\n      0 5px 12px 4px rgba(0, 0, 0, 0.09)\n    ',
    boxShadowDrawerRight:
      '\n      -6px 0 16px 0 rgba(0, 0, 0, 0.08),\n      -3px 0 6px -4px rgba(0, 0, 0, 0.12),\n      -9px 0 28px 8px rgba(0, 0, 0, 0.05)\n    ',
    boxShadowDrawerLeft:
      '\n      6px 0 16px 0 rgba(0, 0, 0, 0.08),\n      3px 0 6px -4px rgba(0, 0, 0, 0.12),\n      9px 0 28px 8px rgba(0, 0, 0, 0.05)\n    ',
    boxShadowDrawerUp:
      '\n      0 6px 16px 0 rgba(0, 0, 0, 0.08),\n      0 3px 6px -4px rgba(0, 0, 0, 0.12),\n      0 9px 28px 8px rgba(0, 0, 0, 0.05)\n    ',
    boxShadowDrawerDown:
      '\n      0 -6px 16px 0 rgba(0, 0, 0, 0.08),\n      0 -3px 6px -4px rgba(0, 0, 0, 0.12),\n      0 -9px 28px 8px rgba(0, 0, 0, 0.05)\n    ',
    boxShadowTabsOverflowLeft: 'inset 10px 0 8px -8px rgba(0, 0, 0, 0.08)',
    boxShadowTabsOverflowRight: 'inset -10px 0 8px -8px rgba(0, 0, 0, 0.08)',
    boxShadowTabsOverflowTop: 'inset 0 10px 8px -8px rgba(0, 0, 0, 0.08)',
    boxShadowTabsOverflowBottom: 'inset 0 -10px 8px -8px rgba(0, 0, 0, 0.08)',
    Menu: {
      colorBgContainer: 'rgb(49,49,61)',
      itemActiveBg: '#ffffff0d',
      colorHighlight: '#ffffff',
    },
    Card: {
      colorBgContainer: '#23232e',
    },
    Drawer: {
      colorText: '#ffffff',
      colorTextBase: '#ffffff',
    },
    Layout: {
      headerBg: 'rgb(49,49,61)',
      bodyBg: 'rgb(49,49,61)',
      footerBg: 'rgb(49,49,61)',
      colorBgContainer: 'rgb(49,49,61)',
    },
    Modal: {
      headerBg: '#1c1c26',
      margin: 0,
      contentBg: '#23232e',
    },
    Button: {
      colorText: '#ffffffd9',
      defaultBg: '#444457',
      borderRadius: 0,
      borderRadiusLG: 0,
      fontSize: 14,
      lineHeight: 24,
    },
    Tabs: {
      fontSize: 14,
      colorPrimary: '#0ba7da',
    },
    Table: {
      motion: false,
      motionDurationSlow: '0s',
      motionDurationFast: '0s',
      borderRadius: 0,
      headerBorderRadius: 0,
      colorBgContainer: '#23232e',
      fontSize: 14,
    },
    Switch: {
      motion: true,
      motionDurationMid: '0.2s',
      colorPrimary: 'rgb(11,167,218)',
      trackHeight: 24,
    },
    Select: {
      optionSelectedBg: 'rgb(28,142,183)',
    },
    _tokenKey: 'mr2whb',
    _themeKey: 'mr2whb',
    _hashId: 'css-dev-only-do-not-override-fymbro',
  },
  'css-dev-only-do-not-override-fymbro',
  {
    blue: '#1677ff',
    purple: '#722ED1',
    cyan: '#13C2C2',
    green: '#52C41A',
    magenta: '#EB2F96',
    pink: '#eb2f96',
    red: '#F5222D',
    orange: '#FA8C16',
    yellow: '#FADB14',
    volcano: '#FA541C',
    geekblue: '#2F54EB',
    gold: '#FAAD14',
    lime: '#A0D911',
    colorPrimary: '#0c91bc',
    colorSuccess: '#49aa19',
    colorWarning: '#d89614',
    colorError: '#dc4446',
    colorInfo: '#1668dc',
    colorLink: '#1668dc',
    colorTextBase: '#fff',
    colorBgBase: '#23232e',
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    fontFamilyCode:
      "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, Courier, monospace",
    fontSize: 12,
    lineWidth: 1,
    lineType: 'solid',
    motionUnit: 0.1,
    motionBase: 0,
    motionEaseOutCirc: 'cubic-bezier(0.08, 0.82, 0.17, 1)',
    motionEaseInOutCirc: 'cubic-bezier(0.78, 0.14, 0.15, 0.86)',
    motionEaseOut: 'cubic-bezier(0.215, 0.61, 0.355, 1)',
    motionEaseInOut: 'cubic-bezier(0.645, 0.045, 0.355, 1)',
    motionEaseOutBack: 'cubic-bezier(0.12, 0.4, 0.29, 1.46)',
    motionEaseInBack: 'cubic-bezier(0.71, -0.46, 0.88, 0.6)',
    motionEaseInQuint: 'cubic-bezier(0.755, 0.05, 0.855, 0.06)',
    motionEaseOutQuint: 'cubic-bezier(0.23, 1, 0.32, 1)',
    borderRadius: 6,
    sizeUnit: 4,
    sizeStep: 4,
    sizePopupArrow: 16,
    controlHeight: 28,
    zIndexBase: 0,
    zIndexPopupBase: 1000,
    opacityImage: 1,
    wireframe: false,
    motion: false,
    colorText: '#ffffffa6',
    colorTextSecondary: '#ffffff73',
    colorTextDisabled: '#ffffff40',
    colorIcon: '#ffffffa6',
    colorIconHover: '#ffffffd9',
    colorBorder: '#17171f',
    fontSizeLG: 16,
    'blue-1': '#111a2c',
    blue1: '#111a2c',
    'blue-2': '#112545',
    blue2: '#112545',
    'blue-3': '#15325b',
    blue3: '#15325b',
    'blue-4': '#15417e',
    blue4: '#15417e',
    'blue-5': '#1554ad',
    blue5: '#1554ad',
    'blue-6': '#1668dc',
    blue6: '#1668dc',
    'blue-7': '#3c89e8',
    blue7: '#3c89e8',
    'blue-8': '#65a9f3',
    blue8: '#65a9f3',
    'blue-9': '#8dc5f8',
    blue9: '#8dc5f8',
    'blue-10': '#b7dcfa',
    blue10: '#b7dcfa',
    'purple-1': '#1a1325',
    purple1: '#1a1325',
    'purple-2': '#24163a',
    purple2: '#24163a',
    'purple-3': '#301c4d',
    purple3: '#301c4d',
    'purple-4': '#3e2069',
    purple4: '#3e2069',
    'purple-5': '#51258f',
    purple5: '#51258f',
    'purple-6': '#642ab5',
    purple6: '#642ab5',
    'purple-7': '#854eca',
    purple7: '#854eca',
    'purple-8': '#ab7ae0',
    purple8: '#ab7ae0',
    'purple-9': '#cda8f0',
    purple9: '#cda8f0',
    'purple-10': '#ebd7fa',
    purple10: '#ebd7fa',
    'cyan-1': '#112123',
    cyan1: '#112123',
    'cyan-2': '#113536',
    cyan2: '#113536',
    'cyan-3': '#144848',
    cyan3: '#144848',
    'cyan-4': '#146262',
    cyan4: '#146262',
    'cyan-5': '#138585',
    cyan5: '#138585',
    'cyan-6': '#13a8a8',
    cyan6: '#13a8a8',
    'cyan-7': '#33bcb7',
    cyan7: '#33bcb7',
    'cyan-8': '#58d1c9',
    cyan8: '#58d1c9',
    'cyan-9': '#84e2d8',
    cyan9: '#84e2d8',
    'cyan-10': '#b2f1e8',
    cyan10: '#b2f1e8',
    'green-1': '#162312',
    green1: '#162312',
    'green-2': '#1d3712',
    green2: '#1d3712',
    'green-3': '#274916',
    green3: '#274916',
    'green-4': '#306317',
    green4: '#306317',
    'green-5': '#3c8618',
    green5: '#3c8618',
    'green-6': '#49aa19',
    green6: '#49aa19',
    'green-7': '#6abe39',
    green7: '#6abe39',
    'green-8': '#8fd460',
    green8: '#8fd460',
    'green-9': '#b2e58b',
    green9: '#b2e58b',
    'green-10': '#d5f2bb',
    green10: '#d5f2bb',
    'magenta-1': '#291321',
    magenta1: '#291321',
    'magenta-2': '#40162f',
    magenta2: '#40162f',
    'magenta-3': '#551c3b',
    magenta3: '#551c3b',
    'magenta-4': '#75204f',
    magenta4: '#75204f',
    'magenta-5': '#a02669',
    magenta5: '#a02669',
    'magenta-6': '#cb2b83',
    magenta6: '#cb2b83',
    'magenta-7': '#e0529c',
    magenta7: '#e0529c',
    'magenta-8': '#f37fb7',
    magenta8: '#f37fb7',
    'magenta-9': '#f8a8cc',
    magenta9: '#f8a8cc',
    'magenta-10': '#fad2e3',
    magenta10: '#fad2e3',
    'pink-1': '#291321',
    pink1: '#291321',
    'pink-2': '#40162f',
    pink2: '#40162f',
    'pink-3': '#551c3b',
    pink3: '#551c3b',
    'pink-4': '#75204f',
    pink4: '#75204f',
    'pink-5': '#a02669',
    pink5: '#a02669',
    'pink-6': '#cb2b83',
    pink6: '#cb2b83',
    'pink-7': '#e0529c',
    pink7: '#e0529c',
    'pink-8': '#f37fb7',
    pink8: '#f37fb7',
    'pink-9': '#f8a8cc',
    pink9: '#f8a8cc',
    'pink-10': '#fad2e3',
    pink10: '#fad2e3',
    'red-1': '#2a1215',
    red1: '#2a1215',
    'red-2': '#431418',
    red2: '#431418',
    'red-3': '#58181c',
    red3: '#58181c',
    'red-4': '#791a1f',
    red4: '#791a1f',
    'red-5': '#a61d24',
    red5: '#a61d24',
    'red-6': '#d32029',
    red6: '#d32029',
    'red-7': '#e84749',
    red7: '#e84749',
    'red-8': '#f37370',
    red8: '#f37370',
    'red-9': '#f89f9a',
    red9: '#f89f9a',
    'red-10': '#fac8c3',
    red10: '#fac8c3',
    'orange-1': '#2b1d11',
    orange1: '#2b1d11',
    'orange-2': '#442a11',
    orange2: '#442a11',
    'orange-3': '#593815',
    orange3: '#593815',
    'orange-4': '#7c4a15',
    orange4: '#7c4a15',
    'orange-5': '#aa6215',
    orange5: '#aa6215',
    'orange-6': '#d87a16',
    orange6: '#d87a16',
    'orange-7': '#e89a3c',
    orange7: '#e89a3c',
    'orange-8': '#f3b765',
    orange8: '#f3b765',
    'orange-9': '#f8cf8d',
    orange9: '#f8cf8d',
    'orange-10': '#fae3b7',
    orange10: '#fae3b7',
    'yellow-1': '#2b2611',
    yellow1: '#2b2611',
    'yellow-2': '#443b11',
    yellow2: '#443b11',
    'yellow-3': '#595014',
    yellow3: '#595014',
    'yellow-4': '#7c6e14',
    yellow4: '#7c6e14',
    'yellow-5': '#aa9514',
    yellow5: '#aa9514',
    'yellow-6': '#d8bd14',
    yellow6: '#d8bd14',
    'yellow-7': '#e8d639',
    yellow7: '#e8d639',
    'yellow-8': '#f3ea62',
    yellow8: '#f3ea62',
    'yellow-9': '#f8f48b',
    yellow9: '#f8f48b',
    'yellow-10': '#fafab5',
    yellow10: '#fafab5',
    'volcano-1': '#2b1611',
    volcano1: '#2b1611',
    'volcano-2': '#441d12',
    volcano2: '#441d12',
    'volcano-3': '#592716',
    volcano3: '#592716',
    'volcano-4': '#7c3118',
    volcano4: '#7c3118',
    'volcano-5': '#aa3e19',
    volcano5: '#aa3e19',
    'volcano-6': '#d84a1b',
    volcano6: '#d84a1b',
    'volcano-7': '#e87040',
    volcano7: '#e87040',
    'volcano-8': '#f3956a',
    volcano8: '#f3956a',
    'volcano-9': '#f8b692',
    volcano9: '#f8b692',
    'volcano-10': '#fad4bc',
    volcano10: '#fad4bc',
    'geekblue-1': '#131629',
    geekblue1: '#131629',
    'geekblue-2': '#161d40',
    geekblue2: '#161d40',
    'geekblue-3': '#1c2755',
    geekblue3: '#1c2755',
    'geekblue-4': '#203175',
    geekblue4: '#203175',
    'geekblue-5': '#263ea0',
    geekblue5: '#263ea0',
    'geekblue-6': '#2b4acb',
    geekblue6: '#2b4acb',
    'geekblue-7': '#5273e0',
    geekblue7: '#5273e0',
    'geekblue-8': '#7f9ef3',
    geekblue8: '#7f9ef3',
    'geekblue-9': '#a8c1f8',
    geekblue9: '#a8c1f8',
    'geekblue-10': '#d2e0fa',
    geekblue10: '#d2e0fa',
    'gold-1': '#2b2111',
    gold1: '#2b2111',
    'gold-2': '#443111',
    gold2: '#443111',
    'gold-3': '#594214',
    gold3: '#594214',
    'gold-4': '#7c5914',
    gold4: '#7c5914',
    'gold-5': '#aa7714',
    gold5: '#aa7714',
    'gold-6': '#d89614',
    gold6: '#d89614',
    'gold-7': '#e8b339',
    gold7: '#e8b339',
    'gold-8': '#f3cc62',
    gold8: '#f3cc62',
    'gold-9': '#f8df8b',
    gold9: '#f8df8b',
    'gold-10': '#faedb5',
    gold10: '#faedb5',
    'lime-1': '#1f2611',
    lime1: '#1f2611',
    'lime-2': '#2e3c10',
    lime2: '#2e3c10',
    'lime-3': '#3e4f13',
    lime3: '#3e4f13',
    'lime-4': '#536d13',
    lime4: '#536d13',
    'lime-5': '#6f9412',
    lime5: '#6f9412',
    'lime-6': '#8bbb11',
    lime6: '#8bbb11',
    'lime-7': '#a9d134',
    lime7: '#a9d134',
    'lime-8': '#c9e75d',
    lime8: '#c9e75d',
    'lime-9': '#e4f88b',
    lime9: '#e4f88b',
    'lime-10': '#f0fab5',
    lime10: '#f0fab5',
    colorTextTertiary: 'rgba(255, 255, 255, 0.45)',
    colorTextQuaternary: 'rgba(255, 255, 255, 0.25)',
    colorFill: 'rgba(255, 255, 255, 0.18)',
    colorFillSecondary: 'rgba(255, 255, 255, 0.12)',
    colorFillTertiary: 'rgba(255, 255, 255, 0.08)',
    colorFillQuaternary: 'rgba(255, 255, 255, 0.04)',
    colorBgLayout: '#23232e',
    colorBgContainer: '#353545',
    colorBgElevated: '#3d3d51',
    colorBgSpotlight: '#5c5c79',
    colorBgBlur: 'rgba(255, 255, 255, 0.04)',
    colorBorderSecondary: '#4d4d65',
    colorPrimaryBg: '#111f26',
    colorPrimaryBgHover: '#0f2f3c',
    colorPrimaryBorder: '#11404f',
    colorPrimaryBorderHover: '#10566d',
    colorPrimaryHover: '#2dadd1',
    colorPrimaryActive: '#0e7495',
    colorPrimaryTextHover: '#2dadd1',
    colorPrimaryText: '#0c91bc',
    colorPrimaryTextActive: '#0e7495',
    colorSuccessBg: '#162312',
    colorSuccessBgHover: '#1d3712',
    colorSuccessBorder: '#274916',
    colorSuccessBorderHover: '#306317',
    colorSuccessHover: '#306317',
    colorSuccessActive: '#3c8618',
    colorSuccessTextHover: '#6abe39',
    colorSuccessText: '#49aa19',
    colorSuccessTextActive: '#3c8618',
    colorErrorBg: '#2c1618',
    colorErrorBgHover: '#451d1f',
    colorErrorBorder: '#5b2526',
    colorErrorBorderHover: '#7e2e2f',
    colorErrorHover: '#e86e6b',
    colorErrorActive: '#ad393a',
    colorErrorTextHover: '#e86e6b',
    colorErrorText: '#dc4446',
    colorErrorTextActive: '#ad393a',
    colorWarningBg: '#2b2111',
    colorWarningBgHover: '#443111',
    colorWarningBorder: '#594214',
    colorWarningBorderHover: '#7c5914',
    colorWarningHover: '#7c5914',
    colorWarningActive: '#aa7714',
    colorWarningTextHover: '#e8b339',
    colorWarningText: '#d89614',
    colorWarningTextActive: '#aa7714',
    colorInfoBg: '#111a2c',
    colorInfoBgHover: '#112545',
    colorInfoBorder: '#15325b',
    colorInfoBorderHover: '#15417e',
    colorInfoHover: '#15417e',
    colorInfoActive: '#1554ad',
    colorInfoTextHover: '#3c89e8',
    colorInfoText: '#1668dc',
    colorInfoTextActive: '#1554ad',
    colorLinkHover: '#15417e',
    colorLinkActive: '#1554ad',
    colorBgMask: 'rgba(0, 0, 0, 0.45)',
    colorWhite: '#fff',
    fontSizeSM: 10,
    fontSizeXL: 16,
    fontSizeHeading1: 32,
    fontSizeHeading2: 26,
    fontSizeHeading3: 20,
    fontSizeHeading4: 16,
    fontSizeHeading5: 14,
    lineHeight: 1.6666666666666667,
    lineHeightLG: 1.5714285714285714,
    lineHeightSM: 1.8,
    fontHeight: 20,
    fontHeightLG: 22,
    fontHeightSM: 18,
    lineHeightHeading1: 1.25,
    lineHeightHeading2: 1.3076923076923077,
    lineHeightHeading3: 1.4,
    lineHeightHeading4: 1.5,
    lineHeightHeading5: 1.5714285714285714,
    sizeXXL: 48,
    sizeXL: 32,
    sizeLG: 16,
    sizeMD: 16,
    sizeMS: 12,
    size: 8,
    sizeSM: 8,
    sizeXS: 4,
    sizeXXS: 4,
    controlHeightSM: 21,
    controlHeightXS: 14,
    controlHeightLG: 35,
    motionDurationFast: '0s',
    motionDurationMid: '0s',
    motionDurationSlow: '0s',
    lineWidthBold: 2,
    borderRadiusXS: 2,
    borderRadiusSM: 4,
    borderRadiusLG: 8,
    borderRadiusOuter: 4,
    colorFillContent: 'rgba(255, 255, 255, 0.12)',
    colorFillContentHover: 'rgba(255, 255, 255, 0.18)',
    colorFillAlter: 'rgba(255, 255, 255, 0.04)',
    colorBgContainerDisabled: 'rgba(255, 255, 255, 0.08)',
    colorBorderBg: '#353545',
    colorSplit: 'rgba(186, 186, 247, 0.18)',
    colorTextPlaceholder: 'rgba(255, 255, 255, 0.25)',
    colorTextHeading: '#ffffffa6',
    colorTextLabel: '#ffffff73',
    colorTextDescription: 'rgba(255, 255, 255, 0.45)',
    colorTextLightSolid: '#fff',
    colorHighlight: '#dc4446',
    colorBgTextHover: 'rgba(255, 255, 255, 0.12)',
    colorBgTextActive: 'rgba(255, 255, 255, 0.18)',
    colorErrorOutline: 'rgba(39, 5, 0, 0.65)',
    colorWarningOutline: 'rgba(40, 26, 0, 0.75)',
    fontSizeIcon: 10,
    lineWidthFocus: 4,
    controlOutlineWidth: 2,
    controlInteractiveSize: 14,
    controlItemBgHover: 'rgba(255, 255, 255, 0.08)',
    controlItemBgActive: '#111f26',
    controlItemBgActiveHover: '#0f2f3c',
    controlItemBgActiveDisabled: 'rgba(255, 255, 255, 0.18)',
    controlTmpOutline: 'rgba(255, 255, 255, 0.04)',
    controlOutline: 'rgba(0, 21, 23, 0.68)',
    fontWeightStrong: 600,
    opacityLoading: 0.65,
    linkDecoration: 'none',
    linkHoverDecoration: 'none',
    linkFocusDecoration: 'none',
    controlPaddingHorizontal: 12,
    controlPaddingHorizontalSM: 8,
    paddingXXS: 4,
    paddingXS: 4,
    paddingSM: 8,
    padding: 8,
    paddingMD: 16,
    paddingLG: 16,
    paddingXL: 32,
    paddingContentHorizontalLG: 16,
    paddingContentVerticalLG: 12,
    paddingContentHorizontal: 12,
    paddingContentVertical: 8,
    paddingContentHorizontalSM: 8,
    paddingContentVerticalSM: 4,
    marginXXS: 4,
    marginXS: 4,
    marginSM: 8,
    margin: 8,
    marginMD: 16,
    marginLG: 16,
    marginXL: 32,
    marginXXL: 48,
    boxShadow:
      '\n      0 6px 16px 0 rgba(0, 0, 0, 0.08),\n      0 3px 6px -4px rgba(0, 0, 0, 0.12),\n      0 9px 28px 8px rgba(0, 0, 0, 0.05)\n    ',
    boxShadowSecondary:
      '\n      0 6px 16px 0 rgba(0, 0, 0, 0.08),\n      0 3px 6px -4px rgba(0, 0, 0, 0.12),\n      0 9px 28px 8px rgba(0, 0, 0, 0.05)\n    ',
    boxShadowTertiary:
      '\n      0 1px 2px 0 rgba(0, 0, 0, 0.03),\n      0 1px 6px -1px rgba(0, 0, 0, 0.02),\n      0 2px 4px 0 rgba(0, 0, 0, 0.02)\n    ',
    screenXS: 480,
    screenXSMin: 480,
    screenXSMax: 575,
    screenSM: 576,
    screenSMMin: 576,
    screenSMMax: 767,
    screenMD: 768,
    screenMDMin: 768,
    screenMDMax: 991,
    screenLG: 992,
    screenLGMin: 992,
    screenLGMax: 1199,
    screenXL: 1200,
    screenXLMin: 1200,
    screenXLMax: 1599,
    screenXXL: 1600,
    screenXXLMin: 1600,
    boxShadowPopoverArrow: '2px 2px 5px rgba(0, 0, 0, 0.05)',
    boxShadowCard:
      '\n      0 1px 2px -2px rgba(0, 0, 0, 0.16),\n      0 3px 6px 0 rgba(0, 0, 0, 0.12),\n      0 5px 12px 4px rgba(0, 0, 0, 0.09)\n    ',
    boxShadowDrawerRight:
      '\n      -6px 0 16px 0 rgba(0, 0, 0, 0.08),\n      -3px 0 6px -4px rgba(0, 0, 0, 0.12),\n      -9px 0 28px 8px rgba(0, 0, 0, 0.05)\n    ',
    boxShadowDrawerLeft:
      '\n      6px 0 16px 0 rgba(0, 0, 0, 0.08),\n      3px 0 6px -4px rgba(0, 0, 0, 0.12),\n      9px 0 28px 8px rgba(0, 0, 0, 0.05)\n    ',
    boxShadowDrawerUp:
      '\n      0 6px 16px 0 rgba(0, 0, 0, 0.08),\n      0 3px 6px -4px rgba(0, 0, 0, 0.12),\n      0 9px 28px 8px rgba(0, 0, 0, 0.05)\n    ',
    boxShadowDrawerDown:
      '\n      0 -6px 16px 0 rgba(0, 0, 0, 0.08),\n      0 -3px 6px -4px rgba(0, 0, 0, 0.12),\n      0 -9px 28px 8px rgba(0, 0, 0, 0.05)\n    ',
    boxShadowTabsOverflowLeft: 'inset 10px 0 8px -8px rgba(0, 0, 0, 0.08)',
    boxShadowTabsOverflowRight: 'inset -10px 0 8px -8px rgba(0, 0, 0, 0.08)',
    boxShadowTabsOverflowTop: 'inset 0 10px 8px -8px rgba(0, 0, 0, 0.08)',
    boxShadowTabsOverflowBottom: 'inset 0 -10px 8px -8px rgba(0, 0, 0, 0.08)',
    Menu: {
      colorBgContainer: 'rgb(49,49,61)',
      itemActiveBg: '#ffffff0d',
      colorHighlight: '#ffffff',
    },
    Card: {
      colorBgContainer: '#23232e',
    },
    Drawer: {
      colorText: '#ffffff',
      colorTextBase: '#ffffff',
    },
    Layout: {
      headerBg: 'rgb(49,49,61)',
      bodyBg: 'rgb(49,49,61)',
      footerBg: 'rgb(49,49,61)',
      colorBgContainer: 'rgb(49,49,61)',
    },
    Modal: {
      headerBg: '#1c1c26',
      margin: 0,
      contentBg: '#23232e',
    },
    Button: {
      colorText: '#ffffffd9',
      defaultBg: '#444457',
      borderRadius: 0,
      borderRadiusLG: 0,
      fontSize: 14,
      lineHeight: 24,
    },
    Tabs: {
      fontSize: 14,
      colorPrimary: '#0ba7da',
    },
    Table: {
      motion: false,
      motionDurationSlow: '0s',
      motionDurationFast: '0s',
      borderRadius: 0,
      headerBorderRadius: 0,
      colorBgContainer: '#23232e',
      fontSize: 14,
    },
    Switch: {
      motion: true,
      motionDurationMid: '0.2s',
      colorPrimary: 'rgb(11,167,218)',
      trackHeight: 24,
    },
    Select: {
      optionSelectedBg: 'rgb(28,142,183)',
    },
    _tokenKey: 'mr2whb',
  },
  '',
  '',
] as any;

export default (...args: any[]) => {
  const [cacheUpdate, setCacheUpdate] = useState(0);
  if (!cacheArgs || args[0] !== cacheArgs[0]) {
    cacheArgs = args;
    if (setArgUpdate) {
      setTimeout(() => setArgUpdate(Math.random()), 50);
    }
  }

  useEffect(() => {
    const interval = setInterval(() => {
      setCacheUpdate(Math.random());
    }, rerenderTime);
    return () => clearInterval(interval);
  }, []);

  return cachedToken;
};

const PollCacheTokenHelper = () => {
  const [renderNonce, setRenderNonce] = useState(0);
  // @ts-ignore
  const res = useCacheTokenHelper(...cacheArgs);
  if (res) {
    cachedToken = res;
  }

  // rerender every 5 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      setRenderNonce(Math.random());
    }, rerenderTime);
    return () => clearInterval(interval);
  }, []);

  return null;
};

export const PollCacheToken = React.memo(() => {
  const [argUpdate, _setArgUpdate] = useState(0);
  setArgUpdate = _setArgUpdate;
  return cacheArgs ? <PollCacheTokenHelper /> : null;
});
