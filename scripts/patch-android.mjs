/**
 * 复制原生插件并注册 MainActivity。
 * 必须在 `npx cap sync android` **之后**再跑（sync 可能重置 MainActivity）。
 *
 * 原生插件用 **Java**（不依赖 Kotlin），避免 CI 因 kotlin 插件 ID / jvmTarget 失败。
 * 用法：node scripts/patch-android.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const androidDir = path.join(root, 'android');
const appDir = path.join(androidDir, 'app');
const pkg = 'com.abs.agentapp';
const javaDir = path.join(appDir, 'src', 'main', 'java', ...pkg.split('.'));
const nativeSrc = path.join(root, 'android-native');

/** 优先 Java；若尚无 Java 则回退复制 Kotlin（兼容旧仓库） */
const plugins = [
  { java: 'FtpPlugin.java', kt: 'FtpPlugin.kt' },
  { java: 'ProjectStoragePlugin.java', kt: 'ProjectStoragePlugin.kt' },
];

function die(msg) {
  console.error(msg);
  process.exit(1);
}

if (!fs.existsSync(androidDir)) {
  die('未找到 android/ 目录。请先运行：npx cap add android');
}

fs.mkdirSync(javaDir, { recursive: true });

for (const p of plugins) {
  const javaSrc = path.join(nativeSrc, p.java);
  const ktSrc = path.join(nativeSrc, p.kt);
  if (fs.existsSync(javaSrc)) {
    const dest = path.join(javaDir, p.java);
    fs.copyFileSync(javaSrc, dest);
    // 删除同名 .kt，避免重复类
    const ktDest = path.join(javaDir, p.kt);
    if (fs.existsSync(ktDest)) {
      fs.unlinkSync(ktDest);
      console.log(`已移除旧 ${p.kt}`);
    }
    console.log(`已复制 ${p.java}`);
  } else if (fs.existsSync(ktSrc)) {
    fs.copyFileSync(ktSrc, path.join(javaDir, p.kt));
    console.log(`已复制 ${p.kt}（建议迁移为 Java）`);
  } else {
    console.warn(`跳过缺失插件：${p.java} / ${p.kt}`);
  }
}

/** 根 build.gradle：若已无 Kotlin 依赖可保留；纯 Java 不强制添加 */
const rootGradlePath = path.join(androidDir, 'build.gradle');
if (fs.existsSync(rootGradlePath)) {
  let rootGradle = fs.readFileSync(rootGradlePath, 'utf8');
  // 去掉错误的 / 不必要的 kotlin 插件 classpath（纯 Java 工程）
  if (rootGradle.includes('kotlin-gradle-plugin')) {
    rootGradle = rootGradle.replace(
      /\n\s*classpath\s+'org\.jetbrains\.kotlin:kotlin-gradle-plugin:[^']+'\s*/g,
      '\n',
    );
    fs.writeFileSync(rootGradlePath, rootGradle);
    console.log('已移除 kotlin-gradle-plugin（原生插件改为 Java）');
  }
}

/** app/build.gradle：去掉 kotlin apply；确保 commons-net + version */
const gradlePath = path.join(appDir, 'build.gradle');
if (fs.existsSync(gradlePath)) {
  let gradle = fs.readFileSync(gradlePath, 'utf8');
  gradle = gradle.replace(/^apply plugin:\s*'org\.jetbrains\.kotlin\.android'\s*\n/gm, '');
  gradle = gradle.replace(/^apply plugin:\s*'kotlin-android'\s*\n/gm, '');
  // 去掉 kotlinOptions 块（若有）
  gradle = gradle.replace(/\s*kotlinOptions\s*\{[^}]*\}\s*/g, '\n');

  const dep = "implementation 'commons-net:commons-net:3.11.1'";
  if (!gradle.includes('commons-net')) {
    gradle = gradle.replace(
      /dependencies\s*\{/,
      `dependencies {\n    ${dep}`,
    );
  }

  // 确保 Java 17（Capacitor 6 / AGP 8）
  if (!gradle.includes('compileOptions')) {
    gradle = gradle.replace(
      /defaultConfig\s*\{/,
      `compileOptions {\n        sourceCompatibility JavaVersion.VERSION_17\n        targetCompatibility JavaVersion.VERSION_17\n    }\n    defaultConfig {`,
    );
  }

  try {
    const pkgJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const ver = String(pkgJson.version || '1.0.0');
    const parts = ver.split('.').map((n) => parseInt(n, 10) || 0);
    const versionCode = Math.max(1, (parts[0] || 0) * 10000 + (parts[1] || 0) * 100 + (parts[2] || 0));
    if (/versionName\s+"[^"]*"/.test(gradle)) {
      gradle = gradle.replace(/versionName\s+"[^"]*"/, `versionName "${ver}"`);
    }
    if (/versionCode\s+\d+/.test(gradle)) {
      gradle = gradle.replace(/versionCode\s+\d+/, `versionCode ${versionCode}`);
    }
    console.log(`已注入 Android 版本 versionName=${ver} versionCode=${versionCode}`);
  } catch (e) {
    console.warn('注入 Android 版本失败', e);
  }
  fs.writeFileSync(gradlePath, gradle);
  console.log('已更新 app/build.gradle');
}

const manifestPath = path.join(appDir, 'src', 'main', 'AndroidManifest.xml');
if (fs.existsSync(manifestPath)) {
  let manifest = fs.readFileSync(manifestPath, 'utf8');
  let changed = false;
  if (!manifest.includes('usesCleartextTraffic')) {
    manifest = manifest.replace(
      /<application/,
      '<application\n        android:usesCleartextTraffic="true"',
    );
    changed = true;
    console.log('已开启 Android 明文 HTTP（usesCleartextTraffic）');
  }
  if (manifest.includes('android:allowBackup="true"')) {
    manifest = manifest.replace('android:allowBackup="true"', 'android:allowBackup="false"');
    changed = true;
    console.log('已关闭 android:allowBackup');
  }
  if (!manifest.includes('android.permission.INTERNET')) {
    manifest = manifest.replace(
      '</manifest>',
      '    <uses-permission android:name="android.permission.INTERNET" />\n</manifest>',
    );
    changed = true;
  }
  if (changed) fs.writeFileSync(manifestPath, manifest);
}

/** 强制写入带插件注册的 MainActivity */
const mainJava = path.join(javaDir, 'MainActivity.java');
const mainKt = path.join(javaDir, 'MainActivity.kt');
const mainContent = `package com.abs.agentapp;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 必须在 super.onCreate 之前注册自定义插件
        registerPlugin(FtpPlugin.class);
        registerPlugin(ProjectStoragePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
`;

if (fs.existsSync(mainKt)) {
  fs.unlinkSync(mainKt);
  console.log('已移除 MainActivity.kt');
}
fs.writeFileSync(mainJava, mainContent);
console.log('已写入 MainActivity.java（含插件注册）');

console.log('\n完成。顺序：npx cap sync android && node scripts/patch-android.mjs');
