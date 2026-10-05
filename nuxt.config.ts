export default defineNuxtConfig({
  devtools: { enabled: false },
  compatibilityDate: "2025-07-15",
  // naive-ui 的 css-render 在 SSR 下访问 document.head 会报错；本工具为离线前端，关闭 SSR 以 SPA 运行。
  ssr: false,
  modules: ["@pinia/nuxt", "@vueuse/nuxt", "@nuxtjs/i18n"],
  // naive-ui 依赖的 vueuc 为 CommonJS，SSR 下需转译，否则命名导出解析失败。
  build: { transpile: ["naive-ui", "vueuc"] },
  css: ["~/assets/main.css"],
  i18n: {
    locales: [{ code: "zh", language: "zh-CN", name: "中文", file: "zh.json" }],
    defaultLocale: "zh",
    strategy: "no_prefix",
    langDir: "locales",
    bundle: { optimizeTranslationDirective: false }
  },
  app: {
    head: {
      title: "灾后需求评估与任务分派",
      meta: [{ name: "viewport", content: "width=device-width, initial-scale=1" }]
    }
  }
});
