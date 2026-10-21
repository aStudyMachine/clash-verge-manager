using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32;

// Windows 专有操作集中在本机辅助程序，不包含方案规则和订阅凭据。
public static class ManagerNative {
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 33554432 };
  static string Text(Dictionary<string, object> input, string key) { return input.ContainsKey(key) ? Convert.ToString(input[key]) : ""; }
  static Dictionary<string, object> Map(object value) { return value as Dictionary<string, object> ?? new Dictionary<string, object>(); }
  static bool Flag(Dictionary<string, object> input, string key) { return input.ContainsKey(key) && Convert.ToBoolean(input[key]); }
  static void Emit(object value) { Console.WriteLine(Json.Serialize(value)); }
  static string Root(Dictionary<string, object> input) {
    string root = Text(input, "configDir");
    if (!Path.IsPathRooted(root) || !File.Exists(Path.Combine(root, "profiles.yaml")) || !File.Exists(Path.Combine(root, "verge.yaml"))) throw new InvalidOperationException();
    return Path.GetFullPath(root);
  }
  static string Key(string value) {
    using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(value.ToLowerInvariant()))).Replace("-", "").Substring(0, 16);
  }
  static bool Same(string first, string second) { return String.Equals(Path.GetFullPath(first), Path.GetFullPath(second), StringComparison.OrdinalIgnoreCase); }
  static bool Running(string executable) {
    if (String.IsNullOrEmpty(executable)) return false;
    string name = Path.GetFileNameWithoutExtension(executable);
    foreach (var process in Process.GetProcessesByName(name)) {
      using (process) {
        try { if (Same(process.MainModule.FileName, executable)) return true; }
        catch { throw new InvalidOperationException(); }
      }
    }
    return false;
  }
  static bool ValidApp(string app) {
    if (!Path.IsPathRooted(app) || !File.Exists(app) || !String.Equals(Path.GetFileName(app), "clash-verge.exe", StringComparison.OrdinalIgnoreCase)) return false;
    var info = FileVersionInfo.GetVersionInfo(app);
    return Regex.IsMatch((info.ProductName ?? "") + " " + (info.FileDescription ?? ""), "clash.verge", RegexOptions.IgnoreCase);
  }
  static dynamic Scheduler() {
    dynamic service = Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service"));
    service.Connect();
    return service;
  }
  static dynamic FindTask(dynamic folder, string name) {
    try { return folder.GetTask(name); } catch (System.Runtime.InteropServices.COMException) { return null; }
  }
  static string TaskName(string root) { return "ClashManager-Stability-" + Key(root); }
  static Dictionary<string, object> Monitor(Dictionary<string, object> input) {
    string root = Root(input);
    dynamic folder = Scheduler().GetFolder("\\");
    string name = TaskName(root);
    dynamic task = FindTask(folder, name);
    bool legacy = false;
    if (task == null) { name = "MyClash-Taiwan-Stability"; task = FindTask(folder, name); legacy = task != null; }
    if (task == null) return new Dictionary<string, object> { {"exists", false}, {"running", false}, {"enabled", false} };
    dynamic actions = task.Definition.Actions;
    if (actions.Count != 1) throw new InvalidOperationException();
    string arguments = Convert.ToString(actions[1].Arguments);
    if (legacy) {
      var match = Regex.Match(arguments, "\"([^\"]+stability\\.py)\"");
      if (!match.Success || !arguments.Contains("--run")) throw new InvalidOperationException();
      var repo = Directory.GetParent(Directory.GetParent(Path.GetDirectoryName(match.Groups[1].Value)).FullName).FullName;
      string env = Path.Combine(repo, ".env");
      if (!File.Exists(env)) throw new InvalidOperationException();
      var entries = File.ReadAllLines(env).Where(line => Regex.IsMatch(line, "^\\s*CLASH_VERGE_CONFIG_DIR\\s*=")).ToArray();
      if (entries.Length != 1 || !Same(entries[0].Substring(entries[0].IndexOf('=') + 1).Trim().Trim('"', '\''), root)) throw new InvalidOperationException();
    } else {
      var match = Regex.Match(arguments, "(?:^|\\s)--config-dir\\s+\"([^\"]+)\"");
      if (!arguments.Contains("--monitor") || !match.Success || !Same(match.Groups[1].Value, root) || Convert.ToString(task.Definition.RegistrationInfo.Description) != "仅评估已确认的稳定池" || !Path.IsPathRooted(Convert.ToString(actions[1].Path))) throw new InvalidOperationException();
    }
    return new Dictionary<string, object> { {"exists", true}, {"running", (int)task.State == 4}, {"enabled", (bool)task.Enabled}, {"name", name}, {"xml", Convert.ToString(task.Xml)}, {"legacy", legacy} };
  }

  static void Pause(Dictionary<string, object> input) {
    string root = Root(input);
    var state = Map(input["state"]);
    dynamic task = FindTask(Scheduler().GetFolder("\\"), Text(state, "name"));
    if (task == null) throw new InvalidOperationException();
    task.Enabled = false;
    string directory = Path.Combine(root, Flag(state, "legacy") ? "stability-monitor" : "config-manager\\monitor");
    Directory.CreateDirectory(directory);
    File.WriteAllText(Path.Combine(directory, "stop"), "停止并清理动态优先值", new UTF8Encoding(false));
    var deadline = DateTime.UtcNow.AddSeconds(60);
    while ((int)task.State == 4 && DateTime.UtcNow < deadline) Thread.Sleep(200);
    if ((int)task.State == 4 || (Flag(state, "running") && Convert.ToInt32(task.LastTaskResult) != 0)) throw new InvalidOperationException();
    Emit(new { stopped = true });
  }

  static string Quote(string value) { return "\"" + value.Replace("\"", "\\\"") + "\""; }
  static void Resume(Dictionary<string, object> input) {
    string root = Root(input);
    var state = Map(input["state"]);
    dynamic service = Scheduler();
    dynamic folder = service.GetFolder("\\");
    if (Flag(input, "migrate")) {
      string executable = Text(input, "managerExecutable");
      if (!Path.IsPathRooted(executable) || !File.Exists(executable)) throw new InvalidOperationException();
      dynamic definition = service.NewTask(0);
      if (Flag(state, "legacy")) {
        dynamic previous = FindTask(folder, Text(state, "name"));
        if (previous != null) { if ((int)previous.State == 4) throw new InvalidOperationException(); previous.Enabled = false; }
      }
      definition.RegistrationInfo.Description = "仅评估已确认的稳定池";
      definition.Principal.UserId = System.Security.Principal.WindowsIdentity.GetCurrent().Name;
      definition.Principal.LogonType = 3;
      definition.Principal.RunLevel = 0;
      definition.Settings.MultipleInstances = 2;
      definition.Settings.ExecutionTimeLimit = "PT0S";
      definition.Settings.DisallowStartIfOnBatteries = false;
      definition.Settings.StopIfGoingOnBatteries = false;
      definition.Settings.Hidden = true;
      dynamic trigger = definition.Triggers.Create(9);
      trigger.UserId = definition.Principal.UserId;
      dynamic action = definition.Actions.Create(0);
      action.Path = executable;
      action.Arguments = Text(input, "managerArguments") + " --monitor --config-dir " + Quote(root) + " --data-dir " + Quote(Text(input, "dataDir"));
      dynamic created = folder.RegisterTaskDefinition(TaskName(root), definition, 6, null, null, 3, null);
      string stop = Path.Combine(root, "config-manager\\monitor\\stop");
      if (File.Exists(stop)) File.Delete(stop);
      created.Enabled = Flag(state, "enabled");
      if (Flag(state, "running")) { created.Enabled = true; created.Run(null); if (!Flag(state, "enabled")) created.Enabled = false; }
    } else {
      string name = Text(state, "name");
      dynamic task = FindTask(folder, name);
      if (Flag(state, "legacy")) {
        dynamic current = FindTask(folder, TaskName(root));
        if (current != null) {
          if ((int)current.State == 4 || Flag(Monitor(input), "legacy")) throw new InvalidOperationException();
          folder.DeleteTask(TaskName(root), 0);
        }
      }
      if (!String.IsNullOrEmpty(Text(state, "xml"))) {
        if (task != null && (int)task.State == 4) throw new InvalidOperationException();
        task = folder.RegisterTask(name, Text(state, "xml"), 6, null, null, 3, null);
      }
      if (task == null) throw new InvalidOperationException();
      string stop = Path.Combine(root, Flag(state, "legacy") ? "stability-monitor\\stop" : "config-manager\\monitor\\stop");
      if (File.Exists(stop)) File.Delete(stop);
      task.Enabled = Flag(state, "enabled");
      if (Flag(state, "running")) { task.Enabled = true; task.Run(null); if (!Flag(state, "enabled")) task.Enabled = false; }
    }
    Emit(new { resumed = true });
  }

  static void Discover() {
    var applications = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    foreach (var process in Process.GetProcessesByName("clash-verge")) {
      using (process) { try { applications.Add(process.MainModule.FileName); } catch { } }
    }
    foreach (var hive in new[] { Registry.CurrentUser, Registry.LocalMachine }) {
      foreach (var subkey in new[] { "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall", "Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall" }) {
        using (var entries = hive.OpenSubKey(subkey)) {
          if (entries == null) continue;
          foreach (var key in entries.GetSubKeyNames()) using (var entry = entries.OpenSubKey(key)) {
            string name = Convert.ToString(entry.GetValue("DisplayName"));
            if (!Regex.IsMatch(name, "^Clash Verge", RegexOptions.IgnoreCase)) continue;
            string location = Convert.ToString(entry.GetValue("InstallLocation"));
            if (!String.IsNullOrEmpty(location)) applications.Add(Path.Combine(location.Trim('"'), "clash-verge.exe"));
            string icon = Convert.ToString(entry.GetValue("DisplayIcon"));
            if (!String.IsNullOrEmpty(icon)) applications.Add(Regex.Replace(icon, ",\\d+$", "").Trim('"'));
          }
        }
      }
    }
    var items = applications.Where(ValidApp).Select(app => new { path = app, version = FileVersionInfo.GetVersionInfo(app).ProductVersion, running = Running(app), cores = new[] { Path.Combine(Path.GetDirectoryName(app), "verge-mihomo.exe"), Path.Combine(Path.GetDirectoryName(app), "resources", "verge-mihomo.exe") }.Where(File.Exists).ToArray() }).ToArray();
    string config = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "io.github.clash-verge-rev.clash-verge-rev");
    Emit(new { applications = items, configCandidates = File.Exists(Path.Combine(config, "profiles.yaml")) ? new[] { config } : new string[0] });
  }

  static int Main(string[] args) {
    Console.OutputEncoding = new UTF8Encoding(false);
    try {
      string action = args.Length > 0 ? args[0] : "discover";
      var input = args.Length > 1 ? Json.Deserialize<Dictionary<string, object>>(args[1]) : new Dictionary<string, object>();
      if (action == "discover") { Discover(); return 0; }
      if (action == "extract") {
        string destination = Path.GetFullPath(Text(input, "destination"));
        Directory.CreateDirectory(destination);
        using (var zip = ZipFile.OpenRead(Text(input, "archive"))) foreach (var entry in zip.Entries) {
          string target = Path.GetFullPath(Path.Combine(destination, entry.FullName));
          if (!target.StartsWith(destination + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException();
          if (String.IsNullOrEmpty(entry.Name)) Directory.CreateDirectory(target);
          else { Directory.CreateDirectory(Path.GetDirectoryName(target)); entry.ExtractToFile(target, false); }
        }
        Emit(new { extracted = true }); return 0;
      }
      string root = Root(input);
      if (action == "mutex") {
        using (var mutex = new Mutex(false, "Local\\ClashManager-" + Key(root + Text(input, "scope")))) {
          bool acquired;
          try { acquired = mutex.WaitOne(0); } catch (AbandonedMutexException) { acquired = true; }
          if (!acquired) return 2;
          try { Console.WriteLine("locked"); Console.Out.Flush(); Console.In.ReadToEnd(); } finally { mutex.ReleaseMutex(); }
        }
        return 0;
      }
      if (action == "status") { Emit(new { running = Running(Text(input, "appPath")) || (!String.IsNullOrEmpty(Text(input, "corePath")) && Running(Text(input, "corePath"))) }); return 0; }
      if (action == "inspect") {
        string app = Text(input, "appPath");
        bool valid = ValidApp(app);
        string version = valid ? FileVersionInfo.GetVersionInfo(app).ProductVersion : "unknown";
        string core = Text(input, "corePath");
        bool supported = valid && Regex.IsMatch(version ?? "", "^2\\.5\\.8(?:\\D|$)") && File.Exists(core) && Regex.IsMatch(Path.GetFileName(core), "^(?:verge-)?mihomo(?:[-.].*)?\\.exe$|^(?:verge-)?mihomo\\.exe$", RegexOptions.IgnoreCase);
        Emit(new { supported, version, running = valid && Running(app) }); return 0;
      }
      if (action == "monitor-status") { Emit(Monitor(input)); return 0; }
      if (action == "monitor-remove") {
        var state = Monitor(input);
        if (Flag(state, "exists")) {
          if (Flag(state, "legacy") || Flag(state, "running")) throw new InvalidOperationException();
          Scheduler().GetFolder("\\").DeleteTask(TaskName(root), 0);
        }
        Emit(new { removed = true }); return 0;
      }
      if (action == "monitor-pause") { Pause(input); return 0; }
      if (action == "monitor-resume") { Resume(input); return 0; }
      throw new InvalidOperationException();
    } catch (Exception error) {
      Emit(new { error = "本机操作失败", kind = error.GetType().Name });
      return 1;
    }
  }
}
