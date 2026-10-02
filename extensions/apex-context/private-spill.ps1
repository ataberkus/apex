param([Parameter(Mandatory=$true)][string]$Root, [string]$Name = '', [switch]$DirectoryOnly)
$ErrorActionPreference = 'Stop'
try {
    if (($DirectoryOnly -and $Name) -or (-not $DirectoryOnly -and -not $Name)) { throw 'Select a spill name or DirectoryOnly, not both' }
    # Windows PowerShell/.NET Framework supplies atomic ACL creation. Do not
    # substitute chmod or bypass execution policy/constrained language failures.
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

public static class ApexPrivateSpill {
    [StructLayout(LayoutKind.Sequential)]
    struct FileInfo {
        public uint Attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInfo info);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder path, uint length, uint flags);

    static FileInfo Info(SafeFileHandle handle) {
        FileInfo info;
        if (!GetFileInformationByHandle(handle, out info)) throw new Win32Exception();
        return info;
    }
    static string NormalPath(string path) {
        if (path.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) path = @"\\" + path.Substring(8);
        else if (path.StartsWith(@"\\?\", StringComparison.Ordinal)) path = path.Substring(4);
        return path.TrimEnd('\\');
    }
    static SafeFileHandle Pin(string path, bool directory) {
        // OPEN_REPARSE_POINT inspects the entry itself; omitting FILE_SHARE_DELETE
        // pins every ancestor against junction replacement, rename and deletion.
        var handle = CreateFile(path, 0x20080, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
        try {
            if (handle.IsInvalid) throw new Win32Exception();
            var info = Info(handle);
            if ((info.Attributes & 0x400) != 0 || ((info.Attributes & 0x10) != 0) != directory || (!directory && info.Links != 1))
                throw new IOException("Apex spill entries must not be reparse points or hard links");
            var actual = new StringBuilder(path.Length + 16);
            uint length = GetFinalPathNameByHandle(handle, actual, (uint)actual.Capacity, 0);
            if (length == 0) throw new Win32Exception();
            if (length >= actual.Capacity) {
                actual = new StringBuilder(checked((int)length + 1));
                length = GetFinalPathNameByHandle(handle, actual, (uint)actual.Capacity, 0);
                if (length == 0 || length >= actual.Capacity) throw new Win32Exception();
            }
            if (!String.Equals(NormalPath(actual.ToString()), NormalPath(path), StringComparison.OrdinalIgnoreCase))
                throw new IOException("Apex spill directory changed");
            return handle;
        } catch { handle.Dispose(); throw; }
    }
    static void RequirePrivate(FileSystemSecurity security, SecurityIdentifier owner) {
        var rules = security.GetAccessRules(true, true, typeof(SecurityIdentifier));
        if (!security.AreAccessRulesProtected || !security.GetOwner(typeof(SecurityIdentifier)).Equals(owner) || rules.Count != 1)
            throw new IOException("Existing Apex spill entries require a protected owner-only Windows ACL");
        var rule = (FileSystemAccessRule)rules[0];
        if (!rule.IdentityReference.Equals(owner) || rule.AccessControlType != AccessControlType.Allow || rule.FileSystemRights != FileSystemRights.FullControl)
            throw new IOException("Existing Apex spill entries require a protected owner-only Windows ACL");
    }
    static string PrivateDirectory(string parent, string name, SecurityIdentifier owner, List<SafeFileHandle> pins) {
        var path = Path.Combine(parent, name);
        var security = new DirectorySecurity();
        security.SetOwner(owner);
        security.SetAccessRuleProtection(true, false);
        security.AddAccessRule(new FileSystemAccessRule(owner, FileSystemRights.FullControl,
            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        // The descriptor applies at creation, never to an existing public directory.
        Directory.CreateDirectory(path, security);
        pins.Add(Pin(path, true));
        RequirePrivate(Directory.GetAccessControl(path, AccessControlSections.Owner | AccessControlSections.Access), owner);
        return path;
    }
    public static void Spill(string root, string name) {
        if (!Path.IsPathRooted(root) || !String.Equals(Path.GetFullPath(root), root, StringComparison.OrdinalIgnoreCase) ||
            (name.Length != 0 && !Regex.IsMatch(name, @"^[A-Za-z0-9_-]+-[a-f0-9]{32}\.log$"))) throw new IOException("Invalid Apex spill path");
        var owner = WindowsIdentity.GetCurrent().User;
        var pins = new List<SafeFileHandle>();
        string temporary = null, final = null;
        bool created = false, published = false;
        try {
            var ancestor = Path.GetPathRoot(root);
            pins.Add(Pin(ancestor, true));
            foreach (var segment in root.Substring(ancestor.Length).Split(new char[] {'\\'}, StringSplitOptions.RemoveEmptyEntries)) {
                ancestor = Path.Combine(ancestor, segment);
                pins.Add(Pin(ancestor, true));
            }
            var apex = PrivateDirectory(root, ".apex", owner, pins);
            // Checkpoints and learnings share the same atomic private root. No
            // dummy log, out directory, or data byte is created in this mode.
            if (name.Length == 0) return;
            var output = PrivateDirectory(apex, "out", owner, pins);
            temporary = Path.Combine(output, "." + name + ".tmp");
            final = Path.Combine(output, name);
            var security = new FileSecurity();
            security.SetOwner(owner);
            security.SetAccessRuleProtection(true, false);
            security.AddAccessRule(new FileSystemAccessRule(owner, FileSystemRights.FullControl, AccessControlType.Allow));
            // CREATE_NEW refuses existing files, symlinks and hard links. The ACL
            // is private before the first raw byte arrives through stdin.
            using (var file = new FileStream(temporary, FileMode.CreateNew,
                FileSystemRights.Read | FileSystemRights.Write | FileSystemRights.ReadPermissions,
                FileShare.None, 4096, FileOptions.WriteThrough, security)) {
                created = true;
                var info = Info(file.SafeFileHandle);
                if ((info.Attributes & 0x410) != 0 || info.Links != 1) throw new IOException("Apex log must be a fresh regular file");
                RequirePrivate(file.GetAccessControl(), owner);
                Console.OpenStandardInput().CopyTo(file);
                file.Flush(true);
            }
            // Same-directory Move is atomic and never replaces an existing entry.
            File.Move(temporary, final);
            published = true;
            using (var file = Pin(final, false))
                RequirePrivate(File.GetAccessControl(final, AccessControlSections.Owner | AccessControlSections.Access), owner);
        } catch {
            try { if (published) File.Delete(final); else if (created) File.Delete(temporary); } catch { }
            throw;
        } finally {
            for (int i = pins.Count - 1; i >= 0; --i) pins[i].Dispose();
        }
    }
}
'@
    [ApexPrivateSpill]::Spill($Root, $Name)
} catch {
    [Console]::Error.WriteLine($_.Exception.ToString())
    exit 1
}
