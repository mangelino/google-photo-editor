// ==UserScript==
// @name         Google Photos Range Tools
// @namespace    https://github.com/mangelino/google-photo-editor
// @license      MIT-0
// @version      {{version}}
// @description  {{description}}
// @homepageURL  https://github.com/mangelino/google-photo-editor
// @supportURL   https://github.com/mangelino/google-photo-editor/issues
// @updateURL    https://raw.githubusercontent.com/mangelino/google-photo-editor/main/google-photos-range-tools.user.js
// @downloadURL  https://raw.githubusercontent.com/mangelino/google-photo-editor/main/google-photos-range-tools.user.js
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
 * GENERATED FILE: edit src/ and run `npm run build`.
 *
 * Uses Google Photos' undocumented web RPC endpoint (batchexecute), the same
 * one photos.google.com uses. RPC ids and payload layouts follow
 * Google Photos Toolkit (https://github.com/xob0t/Google-Photos-Toolkit, MIT).
 * Google can change these without notice; if something breaks, the RPC layer
 * in src/core.js is the place to look.
 */
