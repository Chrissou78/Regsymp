import { eleventyImageTransformPlugin } from "@11ty/eleventy-img";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

export default function (eleventyConfig) {
  /**
   * Append a content hash to an asset URL.
   *
   * CSS and JS have stable filenames, so a browser holding a previously
   * cached copy never sees a change. Worse, they were once served with
   * `immutable`, which tells the browser not even to revalidate — those
   * clients are stuck until the URL itself changes. Hashing the query
   * string makes every edit a new resource.
   */
  eleventyConfig.addFilter("bust", (url) => {
    const file = path.join("src", url.replace(/^\//, ""));
    try {
      const hash = createHash("sha1").update(readFileSync(file)).digest("hex").slice(0, 10);
      return `${url}?v=${hash}`;
    } catch {
      return url;
    }
  });

  eleventyConfig.addPassthroughCopy({ "src/assets/css": "assets/css" });
  eleventyConfig.addPassthroughCopy({ "src/assets/js": "assets/js" });
  eleventyConfig.addPassthroughCopy({ "src/assets/images": "assets/images" });

  eleventyConfig.addPlugin(eleventyImageTransformPlugin, {
    extensions: "html",
    formats: ["webp", "auto"],
    widths: [400, 800, 1200, 1800, 2400],
    failOnError: false,
    defaultAttributes: { loading: "lazy", decoding: "async" }
  });

  return {
    dir: { input: "src", output: "_site", includes: "_includes", data: "_data" },
    markdownTemplateEngine: "njk",
    htmlTemplateEngine: "njk"
  };
}
