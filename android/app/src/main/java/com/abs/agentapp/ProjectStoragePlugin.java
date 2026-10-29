package com.abs.agentapp;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import androidx.activity.result.ActivityResult;
import androidx.documentfile.provider.DocumentFile;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONArray;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * 手机本地目录（SAF）读写：同步到沙盒、写回、列目录、会话文件存储。
 * 选择目录时申请可读可写可持久化权限。
 */
@CapacitorPlugin(name = "AgentProjectStorage")
public class ProjectStoragePlugin extends Plugin {

    private static final Set<String> TEXT_EXT = new HashSet<>(Arrays.asList(
        ".php", ".js", ".ts", ".vue", ".css", ".html", ".json", ".md", ".txt",
        ".xml", ".yml", ".yaml", ".env", ".sql", ".sh", ".jsx", ".tsx", ".scss"
    ));
    private static final Set<String> SKIP_DIRS = new HashSet<>(Arrays.asList(
        "node_modules", ".git", "vendor", "dist", "build", ".gradle", "android", "ios"
    ));

    private File sandboxRoot(String projectId) {
        File dir = new File(getContext().getFilesDir(), "agent-app/projects/" + projectId);
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        return dir;
    }

    private String labelFromTreeUri(Uri uri) {
        String raw = uri.getLastPathSegment();
        if (raw == null || raw.isEmpty()) return "已选目录";
        int colon = raw.lastIndexOf(':');
        String name = colon >= 0 ? raw.substring(colon + 1) : raw;
        int slash = name.lastIndexOf('/');
        if (slash >= 0) name = name.substring(slash + 1);
        try {
            String decoded = URLDecoder.decode(name, "UTF-8");
            return decoded == null || decoded.isEmpty() ? "已选目录" : decoded;
        } catch (Exception e) {
            return name.isEmpty() ? "已选目录" : name;
        }
    }

    private boolean takePersistable(Uri uri, int intentFlags) {
        int flags;
        if (intentFlags != 0) {
            flags = intentFlags & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        } else {
            flags = Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION;
        }
        if (flags == 0) {
            flags = Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION;
        }
        try {
            getContext().getContentResolver().takePersistableUriPermission(uri, flags);
            return true;
        } catch (SecurityException e) {
            try {
                getContext().getContentResolver().takePersistableUriPermission(
                    uri,
                    Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                );
                return true;
            } catch (Exception ignored) {
                return false;
            }
        } catch (Exception e) {
            return false;
        }
    }

    @PluginMethod
    public void pickAndPersistDirectory(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(
            Intent.FLAG_GRANT_READ_URI_PERMISSION
                | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
                | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION
        );
        startActivityForResult(call, intent, "pickDirectoryResult");
    }

    @ActivityCallback
    private void pickDirectoryResult(PluginCall call, ActivityResult result) {
        if (result.getResultCode() == Activity.RESULT_CANCELED) {
            call.reject("已取消选择目录");
            return;
        }
        if (result.getResultCode() != Activity.RESULT_OK) {
            call.reject("选择目录失败");
            return;
        }
        Intent data = result.getData();
        Uri uri = data != null ? data.getData() : null;
        if (uri == null) {
            call.reject("未返回目录 URI");
            return;
        }
        boolean ok = takePersistable(uri, data != null ? data.getFlags() : 0);
        DocumentFile root = DocumentFile.fromTreeUri(getContext(), uri);
        if (root == null || !root.canRead()) {
            call.reject("无法读取该目录，请重新授权选择");
            return;
        }
        JSObject ret = new JSObject();
        ret.put("uri", uri.toString());
        ret.put("label", labelFromTreeUri(uri));
        ret.put("persisted", ok);
        ret.put("canWrite", root.canWrite());
        call.resolve(ret);
    }

    @PluginMethod
    public void persistTreeUri(PluginCall call) {
        String treeUri = call.getString("treeUri", "");
        if (treeUri == null || treeUri.isEmpty()) {
            call.reject("treeUri required");
            return;
        }
        try {
            Uri uri = Uri.parse(treeUri);
            boolean ok = takePersistable(uri, 0);
            DocumentFile root = DocumentFile.fromTreeUri(getContext(), uri);
            JSObject ret = new JSObject();
            ret.put("ok", ok && root != null && root.canRead());
            ret.put("canWrite", root != null && root.canWrite());
            if (!ok) ret.put("message", "persist skipped");
            call.resolve(ret);
        } catch (Exception e) {
            call.reject(e.getMessage() != null ? e.getMessage() : "persistTreeUri failed");
        }
    }

    @PluginMethod
    public void verifyTreeAccess(PluginCall call) {
        String treeUri = call.getString("treeUri", "");
        if (treeUri == null || treeUri.isEmpty()) {
            call.reject("treeUri required");
            return;
        }
        new Thread(() -> {
            try {
                Uri uri = Uri.parse(treeUri);
                takePersistable(uri, 0);
                DocumentFile root = DocumentFile.fromTreeUri(getContext(), uri);
                if (root == null) throw new RuntimeException("无法打开目录");
                JSONArray names = new JSONArray();
                if (root.isDirectory() && root.canRead()) {
                    DocumentFile[] children = root.listFiles();
                    int n = Math.min(children.length, 20);
                    for (int i = 0; i < n; i++) {
                        String name = children[i].getName();
                        if (name != null) names.put(name);
                    }
                }
                JSObject ret = new JSObject();
                ret.put("ok", root.canRead());
                ret.put("canWrite", root.canWrite());
                ret.put("names", names);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject(e.getMessage() != null ? e.getMessage() : "verifyTreeAccess failed");
            }
        }).start();
    }

    private DocumentFile getOrCreateDir(DocumentFile root, List<String> parts) {
        DocumentFile dir = root;
        for (String part : parts) {
            if (part == null || part.isEmpty()) continue;
            DocumentFile next = findFileFlexible(dir, part);
            if (next != null && !next.isDirectory()) {
                // 误建成文件（含 .txt）时删掉再按目录建
                next.delete();
                next = null;
            }
            if (next == null) next = dir.createDirectory(part);
            if (next == null) return null;
            dir = next;
        }
        return dir;
    }

    private static class QueueItem {
        final DocumentFile dir;
        final String rel;
        QueueItem(DocumentFile dir, String rel) {
            this.dir = dir;
            this.rel = rel;
        }
    }

    @PluginMethod
    public void syncTree(PluginCall call) {
        String treeUri = call.getString("treeUri", "");
        String projectId = call.getString("projectId", "");
        Integer maxFilesObj = call.getInt("maxFiles");
        int maxFiles = maxFilesObj != null ? maxFilesObj : 800;
        Long maxBytesObj = call.getLong("maxFileBytes");
        long maxBytes = maxBytesObj != null ? maxBytesObj : 512L * 1024L;

        if (treeUri == null || treeUri.isEmpty() || projectId == null || projectId.isEmpty()) {
            call.reject("treeUri and projectId required");
            return;
        }

        new Thread(() -> {
            try {
                DocumentFile root = DocumentFile.fromTreeUri(getContext(), Uri.parse(treeUri));
                if (root == null) throw new RuntimeException("无法打开目录 URI");
                File dest = sandboxRoot(projectId);
                int copied = 0;
                int skipped = 0;
                long bytes = 0L;
                JSONArray errors = new JSONArray();
                ArrayDeque<QueueItem> queue = new ArrayDeque<>();
                queue.add(new QueueItem(root, ""));

                while (!queue.isEmpty() && copied < maxFiles) {
                    QueueItem item = queue.removeFirst();
                    DocumentFile[] children = item.dir.listFiles();
                    for (DocumentFile child : children) {
                        String name = child.getName();
                        if (name == null) continue;
                        if (child.isDirectory()) {
                            if (SKIP_DIRS.contains(name.toLowerCase())) {
                                skipped++;
                                continue;
                            }
                            String sub = item.rel.isEmpty() ? name : item.rel + "/" + name;
                            queue.add(new QueueItem(child, sub));
                        } else if (child.isFile()) {
                            int dot = name.lastIndexOf('.');
                            String ext = dot >= 0 ? name.substring(dot + 1).toLowerCase() : "";
                            String dotted = ext.isEmpty() ? "" : "." + ext;
                            if (!TEXT_EXT.contains(dotted) && !".htaccess".equals(name)) {
                                skipped++;
                                continue;
                            }
                            String relPath = item.rel.isEmpty() ? name : item.rel + "/" + name;
                            long size = child.length();
                            if (size > maxBytes) {
                                skipped++;
                                errors.put(relPath + ": too large");
                                continue;
                            }
                            try {
                                File outFile = new File(dest, relPath);
                                File parent = outFile.getParentFile();
                                if (parent != null) {
                                    //noinspection ResultOfMethodCallIgnored
                                    parent.mkdirs();
                                }
                                try (InputStream input = getContext().getContentResolver().openInputStream(child.getUri());
                                     FileOutputStream output = new FileOutputStream(outFile)) {
                                    if (input == null) throw new RuntimeException("openInputStream failed");
                                    byte[] buf = new byte[8192];
                                    int n;
                                    while ((n = input.read(buf)) >= 0) {
                                        output.write(buf, 0, n);
                                    }
                                }
                                copied++;
                                bytes += size;
                            } catch (Exception e) {
                                errors.put(relPath + ": " + e.getMessage());
                            }
                        }
                    }
                }

                JSObject ret = new JSObject();
                ret.put("copied", copied);
                ret.put("skipped", skipped);
                ret.put("bytes", bytes);
                ret.put("errors", errors);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject(e.getMessage() != null ? e.getMessage() : "sync failed");
            }
        }).start();
    }

    @PluginMethod
    public void exportFiles(PluginCall call) {
        String treeUri = call.getString("treeUri", "");
        String projectId = call.getString("projectId", "");
        JSArray pathsArr = call.getArray("paths");

        if (treeUri == null || treeUri.isEmpty() || projectId == null || projectId.isEmpty() || pathsArr == null) {
            call.reject("treeUri, projectId and paths required");
            return;
        }

        new Thread(() -> {
            try {
                DocumentFile root = DocumentFile.fromTreeUri(getContext(), Uri.parse(treeUri));
                if (root == null) throw new RuntimeException("无法打开目录 URI");
                File srcBase = sandboxRoot(projectId);
                int exported = 0;
                JSONArray errors = new JSONArray();

                for (int i = 0; i < pathsArr.length(); i++) {
                    String rel = pathsArr.getString(i);
                    if (rel == null) continue;
                    if (rel.startsWith(".") || rel.contains("..")) {
                        errors.put(rel + ": invalid path");
                        continue;
                    }
                    File srcFile = new File(srcBase, rel);
                    if (!srcFile.isFile()) {
                        errors.put(rel + ": not in sandbox");
                        continue;
                    }
                    String[] parts = rel.split("/");
                    String fileName = parts[parts.length - 1];
                    List<String> parentParts = new ArrayList<>();
                    for (int p = 0; p < parts.length - 1; p++) parentParts.add(parts[p]);
                    DocumentFile parent = parentParts.isEmpty() ? root : getOrCreateDir(root, parentParts);
                    if (parent == null) {
                        errors.put(rel + ": cannot create parent dir");
                        continue;
                    }
                    try {
                        DocumentFile outDoc = createOrReplaceFile(parent, fileName);
                        if (outDoc == null) throw new RuntimeException("createFile failed");
                        try (FileInputStream input = new FileInputStream(srcFile);
                             OutputStream output = getContext().getContentResolver().openOutputStream(outDoc.getUri())) {
                            if (output == null) throw new RuntimeException("openOutputStream failed");
                            byte[] buf = new byte[8192];
                            int n;
                            while ((n = input.read(buf)) >= 0) {
                                output.write(buf, 0, n);
                            }
                        }
                        exported++;
                    } catch (Exception e) {
                        errors.put(rel + ": " + e.getMessage());
                    }
                }

                JSObject ret = new JSObject();
                ret.put("exported", exported);
                ret.put("errors", errors);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject(e.getMessage() != null ? e.getMessage() : "export failed");
            }
        }).start();
    }

    @PluginMethod
    public void listSandbox(PluginCall call) {
        String projectId = call.getString("projectId", "");
        new Thread(() -> {
            try {
                File base = sandboxRoot(projectId);
                JSONArray files = new JSONArray();
                walkSandbox(base, "", files);
                JSObject ret = new JSObject();
                ret.put("files", files);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject(e.getMessage() != null ? e.getMessage() : "list failed");
            }
        }).start();
    }

    private void walkSandbox(File dir, String prefix, JSONArray files) {
        File[] children = dir.listFiles();
        if (children == null) return;
        for (File f : children) {
            String rel = prefix.isEmpty() ? f.getName() : prefix + "/" + f.getName();
            if (f.isDirectory()) walkSandbox(f, rel, files);
            else files.put(rel);
        }
    }

    private DocumentFile resolveTreeRoot(String treeUri) {
        DocumentFile root = DocumentFile.fromTreeUri(getContext(), Uri.parse(treeUri));
        if (root == null) throw new RuntimeException("无法打开目录 URI");
        return root;
    }

    /**
     * Android SAF：createFile("text/plain", "a.json") 常变成 a.json.txt。
     * 读写统一用不带自动后缀的 MIME，并兼容旧的 .txt 后缀文件。
     */
    private static String mimeForFileName(String fileName) {
        String lower = fileName == null ? "" : fileName.toLowerCase();
        if (lower.endsWith(".json")) return "application/json";
        if (lower.endsWith(".md")) return "text/markdown";
        if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
        if (lower.endsWith(".xml")) return "application/xml";
        if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) {
            return "application/javascript";
        }
        if (lower.endsWith(".ts") || lower.endsWith(".tsx") || lower.endsWith(".jsx")) {
            return "application/octet-stream";
        }
        if (lower.endsWith(".css") || lower.endsWith(".scss")) return "text/css";
        if (lower.endsWith(".vue")) return "application/octet-stream";
        if (lower.endsWith(".php")) return "application/x-httpd-php";
        // 切勿使用 text/plain，否则文件名会被系统追加 .txt
        return "application/octet-stream";
    }

    private DocumentFile findFileFlexible(DocumentFile parent, String name) {
        if (parent == null || name == null || name.isEmpty()) return null;
        DocumentFile exact = parent.findFile(name);
        if (exact != null) return exact;
        DocumentFile txt = parent.findFile(name + ".txt");
        if (txt != null) return txt;
        DocumentFile[] children = parent.listFiles();
        if (children == null) return null;
        for (DocumentFile c : children) {
            String n = c.getName();
            if (n == null) continue;
            if (n.equals(name) || n.equals(name + ".txt")) return c;
            // 部分 ROM 显示名不含扩展，比对其主名
            if (name.contains(".") && n.equals(name.substring(0, name.lastIndexOf('.')))) {
                return c;
            }
        }
        return null;
    }

    private DocumentFile createOrReplaceFile(DocumentFile parent, String fileName) {
        DocumentFile existing = findFileFlexible(parent, fileName);
        if (existing != null) {
            existing.delete();
        }
        DocumentFile out = parent.createFile(mimeForFileName(fileName), fileName);
        if (out == null) {
            // 回退再试一次 octet-stream
            out = parent.createFile("application/octet-stream", fileName);
        }
        return out;
    }

    private DocumentFile findChild(DocumentFile root, List<String> parts) {
        DocumentFile cur = root;
        for (int i = 0; i < parts.size(); i++) {
            String part = parts.get(i);
            if (part == null || part.isEmpty()) continue;
            boolean last = i == parts.size() - 1;
            DocumentFile next = last ? findFileFlexible(cur, part) : cur.findFile(part);
            if (next == null && !last) {
                // 目录偶发被建成 xxx.txt
                next = cur.findFile(part + ".txt");
            }
            if (next == null) return null;
            cur = next;
        }
        return cur;
    }

    private boolean deleteRecursive(DocumentFile doc) {
        if (doc.isDirectory()) {
            for (DocumentFile child : doc.listFiles()) {
                if (!deleteRecursive(child)) return false;
            }
        }
        return doc.delete();
    }

    private List<String> splitPath(String relPath) {
        List<String> parts = new ArrayList<>();
        for (String p : relPath.replaceAll("^/+", "").split("/")) {
            if (!p.isEmpty()) parts.add(p);
        }
        return parts;
    }

    @PluginMethod
    public void writeTreeText(PluginCall call) {
        String treeUri = call.getString("treeUri", "");
        String relPath = call.getString("path", "");
        String data = call.getString("data", "");
        if (treeUri == null || treeUri.isEmpty() || relPath == null || relPath.isEmpty()) {
            call.reject("treeUri and path required");
            return;
        }
        if (relPath.contains("..")) {
            call.reject("invalid path");
            return;
        }
        new Thread(() -> {
            try {
                DocumentFile root = resolveTreeRoot(treeUri);
                List<String> parts = splitPath(relPath);
                String fileName = parts.get(parts.size() - 1);
                DocumentFile parent;
                if (parts.size() == 1) {
                    parent = root;
                } else {
                    parent = getOrCreateDir(root, parts.subList(0, parts.size() - 1));
                }
                if (parent == null) throw new RuntimeException("cannot create parent");
                DocumentFile outDoc = createOrReplaceFile(parent, fileName);
                if (outDoc == null) throw new RuntimeException("createFile failed");
                try (OutputStream output = getContext().getContentResolver().openOutputStream(outDoc.getUri())) {
                    if (output == null) throw new RuntimeException("openOutputStream failed");
                    output.write(data.getBytes(StandardCharsets.UTF_8));
                }
                call.resolve();
            } catch (Exception e) {
                call.reject(e.getMessage() != null ? e.getMessage() : "writeTreeText failed");
            }
        }).start();
    }

    @PluginMethod
    public void readTreeText(PluginCall call) {
        String treeUri = call.getString("treeUri", "");
        String relPath = call.getString("path", "");
        if (treeUri == null || treeUri.isEmpty() || relPath == null || relPath.isEmpty()) {
            call.reject("treeUri and path required");
            return;
        }
        if (relPath.contains("..")) {
            call.reject("invalid path");
            return;
        }
        new Thread(() -> {
            try {
                DocumentFile root = resolveTreeRoot(treeUri);
                DocumentFile doc = findChild(root, splitPath(relPath));
                if (doc == null) throw new RuntimeException("文件不存在");
                if (!doc.isFile()) throw new RuntimeException("不是文件");
                String text;
                try (InputStream input = getContext().getContentResolver().openInputStream(doc.getUri())) {
                    if (input == null) throw new RuntimeException("openInputStream failed");
                    byte[] buf = input.readAllBytes();
                    text = new String(buf, StandardCharsets.UTF_8);
                }
                JSObject ret = new JSObject();
                ret.put("data", text);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject(e.getMessage() != null ? e.getMessage() : "readTreeText failed");
            }
        }).start();
    }

    @PluginMethod
    public void deleteTreePath(PluginCall call) {
        String treeUri = call.getString("treeUri", "");
        String relPath = call.getString("path", "");
        if (treeUri == null || treeUri.isEmpty() || relPath == null || relPath.isEmpty()) {
            call.reject("treeUri and path required");
            return;
        }
        if (relPath.contains("..")) {
            call.reject("invalid path");
            return;
        }
        new Thread(() -> {
            try {
                DocumentFile root = resolveTreeRoot(treeUri);
                DocumentFile doc = findChild(root, splitPath(relPath));
                if (doc != null && !deleteRecursive(doc)) {
                    throw new RuntimeException("删除失败");
                }
                call.resolve();
            } catch (Exception e) {
                call.reject(e.getMessage() != null ? e.getMessage() : "deleteTreePath failed");
            }
        }).start();
    }

    @PluginMethod
    public void listTreeDir(PluginCall call) {
        String treeUri = call.getString("treeUri", "");
        String relPath = call.getString("path", "");
        if (treeUri == null || treeUri.isEmpty()) {
            call.reject("treeUri required");
            return;
        }
        if (relPath != null && relPath.contains("..")) {
            call.reject("invalid path");
            return;
        }
        new Thread(() -> {
            try {
                DocumentFile root = resolveTreeRoot(treeUri);
                DocumentFile dir;
                if (relPath == null || relPath.isBlank()) {
                    dir = root;
                } else {
                    dir = findChild(root, splitPath(relPath));
                    if (dir == null) throw new RuntimeException("目录不存在");
                }
                if (!dir.isDirectory()) throw new RuntimeException("不是目录");
                JSONArray names = new JSONArray();
                for (DocumentFile child : dir.listFiles()) {
                    String name = child.getName();
                    if (name != null) names.put(name);
                }
                JSObject ret = new JSObject();
                ret.put("names", names);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject(e.getMessage() != null ? e.getMessage() : "listTreeDir failed");
            }
        }).start();
    }
}
