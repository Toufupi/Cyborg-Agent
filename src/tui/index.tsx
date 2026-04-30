#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import { App } from "./app.js";

const args = process.argv.slice(2);
const toolIndex = args.indexOf("--tool");
const requestIndex = args.indexOf("--request");
const toolName = toolIndex >= 0 ? args[toolIndex + 1] : undefined;
const requestFile = requestIndex >= 0 ? args[requestIndex + 1] : undefined;

render(<App toolName={toolName} requestFile={requestFile} />);
