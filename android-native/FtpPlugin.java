package com.abs.agentapp;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.apache.commons.net.ftp.FTP;
import org.apache.commons.net.ftp.FTPClient;
import org.apache.commons.net.ftp.FTPFile;
import org.apache.commons.net.ftp.FTPReply;
import org.json.JSONArray;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;

@CapacitorPlugin(name = "AgentFtp")
public class FtpPlugin extends Plugin {

    private FTPClient client(PluginCall call) throws Exception {
        String host = call.getString("host");
        if (host == null || host.isEmpty()) {
            throw new IllegalArgumentException("host required");
        }
        Integer portObj = call.getInt("port");
        int port = portObj != null ? portObj : 21;
        String user = call.getString("username", "");
        String pass = call.getString("password", "");
        Boolean passiveObj = call.getBoolean("passive");
        boolean passive = passiveObj == null || passiveObj;

        FTPClient ftp = new FTPClient();
        ftp.connect(host, port);
        if (!FTPReply.isPositiveCompletion(ftp.getReplyCode())) {
            ftp.disconnect();
            throw new RuntimeException("FTP connect failed");
        }
        if (!ftp.login(user, pass)) {
            throw new RuntimeException("FTP login failed");
        }
        if (passive) {
            ftp.enterLocalPassiveMode();
        }
        ftp.setFileType(FTP.BINARY_FILE_TYPE);
        return ftp;
    }

    @PluginMethod
    public void list(PluginCall call) {
        String remotePath = call.getString("remotePath", "/");
        new Thread(() -> {
            try {
                FTPClient ftp = client(call);
                FTPFile[] files = ftp.listFiles(remotePath);
                if (files == null) {
                    files = new FTPFile[0];
                }
                JSObject ret = new JSObject();
                JSONArray entries = new JSONArray();
                for (FTPFile f : files) {
                    JSObject o = new JSObject();
                    o.put("name", f.getName());
                    String path = remotePath.endsWith("/")
                        ? remotePath + f.getName()
                        : remotePath + "/" + f.getName();
                    o.put("path", path);
                    o.put("isDirectory", f.isDirectory());
                    o.put("size", f.getSize());
                    entries.put(o);
                }
                ret.put("entries", entries);
                ftp.logout();
                ftp.disconnect();
                call.resolve(ret);
            } catch (Exception e) {
                call.reject(e.getMessage() != null ? e.getMessage() : "list failed");
            }
        }).start();
    }

    @PluginMethod
    public void upload(PluginCall call) {
        String localPath = call.getString("localPath", "");
        String remotePath = call.getString("remotePath", "");
        new Thread(() -> {
            try {
                FTPClient ftp = client(call);
                File file = new File(getContext().getFilesDir(), localPath);
                try (FileInputStream input = new FileInputStream(file)) {
                    if (!ftp.storeFile(remotePath, input)) {
                        throw new RuntimeException("storeFile failed");
                    }
                }
                ftp.logout();
                ftp.disconnect();
                JSObject ret = new JSObject();
                ret.put("ok", true);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject(e.getMessage() != null ? e.getMessage() : "upload failed");
            }
        }).start();
    }

    @PluginMethod
    public void download(PluginCall call) {
        String remotePath = call.getString("remotePath", "");
        String localPath = call.getString("localPath", "");
        new Thread(() -> {
            try {
                FTPClient ftp = client(call);
                File file = new File(getContext().getFilesDir(), localPath);
                File parent = file.getParentFile();
                if (parent != null) {
                    //noinspection ResultOfMethodCallIgnored
                    parent.mkdirs();
                }
                try (FileOutputStream output = new FileOutputStream(file)) {
                    if (!ftp.retrieveFile(remotePath, output)) {
                        throw new RuntimeException("retrieveFile failed");
                    }
                }
                ftp.logout();
                ftp.disconnect();
                JSObject ret = new JSObject();
                ret.put("ok", true);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject(e.getMessage() != null ? e.getMessage() : "download failed");
            }
        }).start();
    }

    @PluginMethod
    public void delete(PluginCall call) {
        String remotePath = call.getString("remotePath", "");
        new Thread(() -> {
            try {
                FTPClient ftp = client(call);
                // 先删文件；失败则尝试删空目录（递归清空由 JS 侧负责）
                boolean ok = ftp.deleteFile(remotePath);
                if (!ok) {
                    ok = ftp.removeDirectory(remotePath);
                }
                if (!ok) {
                    throw new RuntimeException("deleteFile/removeDirectory failed");
                }
                ftp.logout();
                ftp.disconnect();
                JSObject ret = new JSObject();
                ret.put("ok", true);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject(e.getMessage() != null ? e.getMessage() : "delete failed");
            }
        }).start();
    }

    @PluginMethod
    public void mkdir(PluginCall call) {
        String remotePath = call.getString("remotePath", "");
        new Thread(() -> {
            try {
                FTPClient ftp = client(call);
                if (!ftp.makeDirectory(remotePath)) {
                    throw new RuntimeException("makeDirectory failed");
                }
                ftp.logout();
                ftp.disconnect();
                JSObject ret = new JSObject();
                ret.put("ok", true);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject(e.getMessage() != null ? e.getMessage() : "mkdir failed");
            }
        }).start();
    }
}
