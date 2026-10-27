/**
 * 复制原生插件、启用 Kotlin、注册 MainActivity。
 * 必须在 `npx cap sync android` **之后**再跑一次（sync 可能重置 MainActivity）。
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
const plugins = ['FtpPlugin.kt', 'ProjectStoragePlugin.kt'];
const KOTLIN_VERSION = '1.9.24';

function die(msg) {
  console.error(msg);
  process.exit(1);
}

if (!fs.existsSync(androidDir)) {
  die('未找到 android/ 目录。请先运行：npx cap add android');
}

fs.mkdirSync(javaDir, { recursive: true });

for (const file of plugins) {
  const src = path.join(nativeSrc, file);
  const dest = path.join(javaDir, file);
  if (!fs.existsSync(src)) {
    console.warn(`跳过缺失文件：${src}`);
    continue;
  }
  fs.copyFileSync(src, dest);
  console.log(`已复制 ${file}`);
}

/** 根 build.gradle：加入 Kotlin 插件（.kt 插件否则不会编译） */
const rootGradlePath = path.join(androidDir, 'build.gradle');
if (fs.existsSync(rootGradlePath)) {
  let rootGradle = fs.readFileSync(rootGradlePath, 'utf8');
  if (!rootGradle.includes('kotlin-gradle-plugin')) {
    if (/classpath\s+'com\.android\.tools\.build:gradle:[^']+'/.test(rootGradle)) {
      rootGradle = rootGradle.replace(
        /(classpath\s+'com\.android\.tools\.build:gradle:[^']+'\s*\n)/,
        `$1        classpath 'org.jetbrains.kotlin:kotlin-gradle-plugin:${KOTLIN_VERSION}'\n`,
      );
    } else if (/dependencies\s*\{/.test(rootGradle)) {
      rootGradle = rootGradle.replace(
        /dependencies\s*\{/,
        `dependencies {\n        classpath 'org.jetbrains.kotlin:kotlin-gradle-plugin:${KOTLIN_VERSION}'`,
      );
    }
    fs.writeFileSync(rootGradlePath, rootGradle);
    console.log(`已向 android/build.gradle 添加 Kotlin ${KOTLIN_VERSION}`);
  }
}

/** app/build.gradle：apply kotlin + commons-net + version */
const gradlePath = path.join(appDir, 'build.gradle');
if (fs.existsSync(gradlePath)) {
  let gradle = fs.readFileSync(gradlePath, 'utf8');
  if (!gradle.includes("org.jetbrains.kotlin.android") && !gradle.includes("kotlin-android")) {
    if (gradle.startsWith('apply plugin:')) {
      gradle = `apply plugin: 'org.jetbrains.kotlin.android'\n${gradle}`;
    } else {
      gradle = `apply plugin: 'org.jetbrains.kotlin.android'\n\n${gradle}`;
    }
    console.log('已 apply org.jetbrains.kotlin.android');
  }
  const dep = "implementation 'commons-net:commons-net:3.11.1'";
  if (!gradle.includes('commons-net')) {
    gradle = gradle.replace(
      /dependencies\s*\{/,
      `dependencies {\n    ${dep}`,
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
  // SAF 目录授权不依赖 READ_EXTERNAL_STORAGE；保留 INTERNET
  if (!manifest.includes('android.permission.INTERNET')) {
    manifest = manifest.replace(
      '</manifest>',
      '    <uses-permission android:name="android.permission.INTERNET" />\n</manifest>',
    );
    changed = true;
  }
  if (changed) fs.writeFileSync(manifestPath, manifest);
}

/** 强制写入带插件注册的 MainActivity（避免 sync 后空壳） */
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
  fs.writeFileSync(mainKt, `package com.abs.agentapp

import android.os.Bundle
import com.getcapacitor.BridgeActivity

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(FtpPlugin::class.java)
        registerPlugin(ProjectStoragePlugin::class.java)
        super.onCreate(savedInstanceState)
    }
}
`);
  console.log('已写入 MainActivity.kt（含插件注册）');
} else {
  fs.writeFileSync(mainJava, mainContent);
  console.log('已写入 MainActivity.java（含插件注册）');
}

console.log('\n完成。请确认顺序：npx cap sync android && node scripts/patch-android.mjs');
