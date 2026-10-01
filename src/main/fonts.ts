// Fonts are embedded (base64) by esbuild so printed documents render identically
// on any machine, fully offline.
import ar400 from '@fontsource/ibm-plex-sans-arabic/files/ibm-plex-sans-arabic-arabic-400-normal.woff2';
import ar700 from '@fontsource/ibm-plex-sans-arabic/files/ibm-plex-sans-arabic-arabic-700-normal.woff2';
import la400 from '@fontsource/ibm-plex-sans-arabic/files/ibm-plex-sans-arabic-latin-400-normal.woff2';
import la700 from '@fontsource/ibm-plex-sans-arabic/files/ibm-plex-sans-arabic-latin-700-normal.woff2';

const face = (data: string, weight: number, range: string) =>
  `@font-face{font-family:'IBM Plex Sans Arabic';font-weight:${weight};font-style:normal;src:url(data:font/woff2;base64,${data}) format('woff2');unicode-range:${range};}`;

const AR = 'U+0600-06FF,U+0750-077F,U+0870-088E,U+0890-0891,U+0898-08E1,U+08E3-08FF,U+200C-200E,U+2010-2011,U+204F,U+2E41,U+FB50-FDFF,U+FE70-FE74,U+FE76-FEFC';
const LA = 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';

export const EMBEDDED_FONT_CSS = [face(ar400, 400, AR), face(ar700, 700, AR), face(la400, 400, LA), face(la700, 700, LA)].join('');
