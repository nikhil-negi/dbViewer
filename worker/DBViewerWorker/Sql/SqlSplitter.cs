namespace DBViewerWorker.Sql;

/// <summary>
/// Splits a script into individual statements on top-level semicolons, skipping
/// semicolons inside string/identifier quotes and comments. Needed for engines
/// whose protocol accepts only one statement per request (ClickHouse HTTP);
/// PostgreSQL sends whole scripts in a single command instead.
/// </summary>
public static class SqlSplitter
{
    public static List<string> Split(string script)
    {
        var statements = new List<string>();
        var start = 0;
        for (var i = 0; i < script.Length; i++)
        {
            var c = script[i];
            switch (c)
            {
                case '\'' or '"' or '`':
                    i = SkipQuoted(script, i, c);
                    break;
                case '-' when i + 1 < script.Length && script[i + 1] == '-':
                    i = SkipLineComment(script, i);
                    break;
                case '/' when i + 1 < script.Length && script[i + 1] == '*':
                    i = SkipBlockComment(script, i);
                    break;
                case ';':
                    Add(statements, script[start..i]);
                    start = i + 1;
                    break;
            }
        }
        Add(statements, script[start..]);
        return statements;
    }

    private static void Add(List<string> into, string statement)
    {
        if (statement.Trim().Length > 0) into.Add(statement.Trim());
    }

    /// <summary>Returns the index of the closing quote (or the last char). Handles doubled quotes and backslash escapes.</summary>
    private static int SkipQuoted(string s, int i, char quote)
    {
        for (var j = i + 1; j < s.Length; j++)
        {
            if (s[j] == '\\' && quote == '\'') { j++; continue; } // ClickHouse allows backslash escapes in strings
            if (s[j] != quote) continue;
            if (j + 1 < s.Length && s[j + 1] == quote) { j++; continue; } // doubled = literal quote
            return j;
        }
        return s.Length - 1;
    }

    private static int SkipLineComment(string s, int i)
    {
        var nl = s.IndexOf('\n', i);
        return nl < 0 ? s.Length - 1 : nl;
    }

    private static int SkipBlockComment(string s, int i)
    {
        var end = s.IndexOf("*/", i + 2, StringComparison.Ordinal);
        return end < 0 ? s.Length - 1 : end + 1;
    }
}
