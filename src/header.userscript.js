// ==UserScript==
// @name         Light Table for Google Photos
// @namespace    https://github.com/mangelino/google-photo-editor
// @author       Massimiliano Angelino
// @license      MIT-0
// @version      {{version}}
// @description  {{description}}
// @homepageURL  https://github.com/mangelino/light-table-for-google-photos
// @supportURL   https://github.com/mangelino/light-table-for-google-photos/issues
// @updateURL    https://raw.githubusercontent.com/mangelino/light-table-for-google-photos/main/light-table-for-google-photos.user.js
// @downloadURL  https://raw.githubusercontent.com/mangelino/light-table-for-google-photos/main/light-table-for-google-photos.user.js
// @match        https://photos.google.com/*
// @run-at       document-idle
// @noframes
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @sandbox      DOM
// @connect      googleusercontent.com
// @connect      usercontent.google.com
// @connect      photos.google.com
// ==/UserScript==

/*
 * Light Table for Google Photos, by Massimiliano Angelino. Made with Kiro (https://kiro.dev).
 *
 * GENERATED FILE: edit src/ and run `npm run build`.
 *
 * @namespace keeps the project's original URL on purpose: Tampermonkey matches a
 * manually (re)installed script to an existing one by @name + @namespace, and
 * keeping one of them stable avoids ending up with two copies after the rename.
 *
 * Uses Google Photos' undocumented web RPC endpoint (batchexecute), the same
 * one photos.google.com uses. RPC ids and payload layouts follow
 * Google Photos Toolkit (https://github.com/xob0t/Google-Photos-Toolkit, MIT).
 * Google can change these without notice; if something breaks, the RPC layer
 * in src/core.js is the place to look.
 */
