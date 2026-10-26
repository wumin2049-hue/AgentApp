/**
 * 在 `npx cap add android` 之后运行，自动复制原生插件并注册。
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
  // 凭据存在 Preferences，关闭系统备份降低泄露风险
  if (manifest.includes('android:allowBackup="true"')) {
    manifest = manifest.replace('android:allowBackup="true"', 'android:allowBackup="false"');
    changed = true;
    console.log('已关闭 android:allowBackup');
  }
  if (changed) fs.writeFileSync(manifestPath, manifest);
}

const gradlePath = path.join(appDir, 'build.gradle');
if (fs.existsSync(gradlePath)) {
  let gradle = fs.readFileSync(gradlePath, 'utf8');
  const dep = "implementation 'commons-net:commons-net:3.11.1'";
  if (!gradle.includes('commons-net')) {
    gradle = gradle.replace(
      /dependencies\s*\{/,
      `dependencies {\n    ${dep}`,
    );
  }
  // 从 package.json 注入 versionName / versionCode
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const ver = String(pkg.version || '1.0.0');
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

const mainCandidates = [
  path.join(javaDir, 'MainActivity.kt'),
  path.join(javaDir, 'MainActivity.java'),
];

let mainPath = mainCandidates.find((p) => fs.existsSync(p));
if (!mainPath) {
  const alt = path.join(appDir, 'src', 'main', 'java');
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.name === 'MainActivity.kt' || ent.name === 'MainActivity.java') {
        mainPath = full;
      }
    }
  };
  if (fs.existsSync(alt)) walk(alt);
}

if (!mainPath) {
  console.warn('未找到 MainActivity，请手动注册 FtpPlugin / ProjectStoragePlugin');
} else {
  let main = fs.readFileSync(mainPath, 'utf8');
  const isKotlin = mainPath.endsWith('.kt');
  const imports = isKotlin
    ? ['import com.abs.agentapp.FtpPlugin', 'import com.abs.agentapp.ProjectStoragePlugin']
    : ['import com.abs.agentapp.FtpPlugin;', 'import com.abs.agentapp.ProjectStoragePlugin;'];
  const registers = isKotlin
    ? ['registerPlugin(FtpPlugin::class.java)', 'registerPlugin(ProjectStoragePlugin::class.java)']
    : ['registerPlugin(FtpPlugin.class);', 'registerPlugin(ProjectStoragePlugin.class);'];

  for (const imp of imports) {
    if (!main.includes(imp)) {
      main = main.replace(
        /(package\s+[\w.]+;?\s*\n)/,
        `$1${imp}\n`,
      );
    }
  }

  if (!main.includes('FtpPlugin')) {
    let patched = false;
    if (main.includes('super.onCreate')) {
      main = main.replace(
        /super\.onCreate\([^)]*\)/,
        (m) => `${m}\n        ${registers.join('\n        ')}`,
      );
      patched = true;
    } else if (main.includes('init()')) {
      main = main.replace(
        /init\s*\(\)\s*\{/,
        (m) => `${m}\n        ${registers.join('\n        ')}\n`,
      );
      patched = true;
    } else if (isKotlin && /class MainActivity/.test(main)) {
      main = main.replace(
        /class MainActivity[^{]+\{/,
        (m) => `${m}\n    override fun onCreate(savedInstanceState: android.os.Bundle?) {\n        super.onCreate(savedInstanceState)\n        ${registers.join('\n        ')}\n    }\n`,
      );
      patched = true;
    } else if (!isKotlin && /class MainActivity/.test(main)) {
      main = main.replace(
        /class MainActivity[^{]+\{/,
        (m) => `${m}\n    @Override\n    public void onCreate(Bundle savedInstanceState) {\n        super.onCreate(savedInstanceState);\n        ${registers.join('\n        ')}\n    }\n`,
      );
      patched = true;
    }
    if (patched) {
      fs.writeFileSync(mainPath, main);
      console.log(`已更新 ${path.relative(root, mainPath)}`);
    } else {
      console.warn('无法自动插入 registerPlugin，请手动编辑 MainActivity');
    }
  } else {
    console.log('MainActivity 已包含插件注册');
  }
}

console.log('\n完成。接下来运行：npx cap sync android && npm run android:icons');
