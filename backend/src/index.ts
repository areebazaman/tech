import { Hono } from "hono";
import { cors } from "hono/cors";
import { supabase, supabaseAdmin, type Student, type StudentCourse } from "./supabase";
import { v4 as uuidv4 } from "uuid";

type RequestContext = {
  requestId: string;
  actorUserId: string | null;
  actorRole: string | null;
  sessionId: string | null;
  ip: string | null;
  userAgent: string | null;
};

const extractContext = async (c: any): Promise<RequestContext> => {
  const headers = (name: string) => c.req.header(name) || c.req.header(name.toLowerCase());
  const requestId = headers("x-request-id") || uuidv4();
  const actorUserId = headers("x-user-id") || null;
  const actorRole = headers("x-user-role") || null;
  const sessionId = headers("x-session-id") || null;
  const ipHeader = headers("x-forwarded-for") || headers("cf-connecting-ip") || headers("x-real-ip");
  const ip = (ipHeader || (c.req.raw as any)?.ip || null) as string | null;
  const userAgent = headers("user-agent") || null;
  return { requestId, actorUserId, actorRole, sessionId, ip, userAgent };
};

const logAudit = async (ctx: RequestContext, action: string, target: { table?: string; id?: string } = {}, details: any = null) => {
  try {
    await supabaseAdmin
      .schema("app")
      .from("audit_log")
      .insert({
        actor_user_id: ctx.actorUserId,
        actor_role: ctx.actorRole,
        action,
        target_table: target.table || null,
        target_id: target.id || null,
        session_id: ctx.sessionId,
        ip_address: ctx.ip,
        user_agent: ctx.userAgent,
        request_id: ctx.requestId,
        details,
      });
  } catch (e) {
    console.error("audit_log insert failed", e);
  }
};

const app = new Hono();

// Global request audit middleware
app.use("/*", async (c, next) => {
  const ctx = await extractContext(c);
  (c as any).requestContext = ctx;
  await logAudit(ctx, "api_call", { table: null, id: null }, {
    method: c.req.method,
    path: c.req.path,
  });
  return next();
});

// CORS — include your frontend on 8080
app.use(
  "/*",
  cors({
    origin: ["http://localhost:8080", "http://localhost:5173", "http://localhost:3000"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

// Health check
app.get("/", (c) =>
  c.json({
    message: "TeachMe.ai Backend API",
    version: "1.0.0",
    status: "running",
    database: "connected",
    note: "If you get permission errors, run this SQL in Supabase: ALTER TABLE users DISABLE ROW LEVEL SECURITY;",
  })
);

// Testing-only: Upload avatar without client session (uses service role if available)
app.post("/api/testing/upload-avatar", async (c) => {
  try {
    const reqCtx: RequestContext = (c as any).requestContext || (await extractContext(c));
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return c.json({
        success: false,
        message:
          "Backend missing SUPABASE_SERVICE_ROLE_KEY. Set it in the backend environment to enable testing uploads without client auth.",
      }, 400);
    }
    const body = await c.req.json<{ userId: string; fileBase64?: string; fileUrl?: string; filename?: string }>();
    const { userId, fileBase64, fileUrl, filename } = body || ({} as any);

    if (!userId) return c.json({ success: false, message: "userId is required" }, 400);
    if (!fileBase64 && !fileUrl) return c.json({ success: false, message: "Provide fileBase64 or fileUrl" }, 400);

    let arrayBuffer: ArrayBuffer;
    let contentType = "image/png";

    if (fileBase64) {
      const commaIdx = fileBase64.indexOf(",");
      const raw = commaIdx >= 0 ? fileBase64.slice(commaIdx + 1) : fileBase64;
      const mimeMatch = /^data:(.*?);base64/.exec(fileBase64);
      if (mimeMatch && mimeMatch[1]) contentType = mimeMatch[1];
      const buffer = Buffer.from(raw, "base64");
      arrayBuffer = buffer;
    } else {
      const resp = await fetch(fileUrl!);
      if (!resp.ok) return c.json({ success: false, message: `Fetch failed: ${resp.status}` }, 400);
      contentType = resp.headers.get("content-type") || contentType;
      arrayBuffer = await resp.arrayBuffer();
    }

    const extFromName = (filename || "").split(".").pop()?.toLowerCase();
    const extFromType = contentType.split("/").pop() || "png";
    const ext = (extFromName || extFromType || "png").replace(/[^a-z0-9]/g, "");
    const objectPath = `${userId}/${uuidv4()}.${ext}`;

    const { error: uploadError } = await supabaseAdmin.storage
      .from("avatars")
      .upload(objectPath, arrayBuffer, {
        contentType,
        cacheControl: "3600",
        upsert: false,
      });
    if (uploadError) return c.json({ success: false, message: uploadError.message }, 400);

    const { data: publicData } = supabaseAdmin.storage.from("avatars").getPublicUrl(objectPath);
    const publicUrl = publicData.publicUrl;

    const { error: updateError } = await supabaseAdmin
      .from("users")
      .update({ profile_picture_url: publicUrl })
      .eq("id", userId);
    if (updateError) return c.json({ success: false, message: updateError.message }, 400);

    await logAudit(reqCtx, "update_profile_picture", { table: "users", id: userId }, { publicUrl });
    return c.json({ success: true, publicUrl });
  } catch (err: any) {
    console.error("/api/testing/upload-avatar error:", err);
    return c.json({ success: false, message: err?.message || "Upload failed" }, 500);
  }
});

// Get all students with their courses and progress
app.get("/api/students", async (c) => {
  try {
    const reqCtx: RequestContext = (c as any).requestContext || (await extractContext(c));
    // Fetch all users who are students
    const { data: students, error: studentsError } = await supabase
      .from("users")
      .select(
        `
        id,
        email,
        full_name,
        gender,
        phone_number,
        profile_picture_url,
        bio,
        language_preference,
        created_at
      `
      )
      .is("deleted_at", null)
      .order("created_at", { ascending: false });

    if (studentsError) {
      console.error("Error fetching students:", studentsError);
      return c.json(
        { success: false, message: "Failed to fetch students" },
        500
      );
    }

    // For each student, fetch their enrollments and course progress
    const studentsWithCourses = await Promise.all(
      students.map(async (student) => {
        // Get student enrollments
        const { data: enrollments, error: enrollmentsError } = await supabase
          .from("enrollments")
          .select(
            `
            course_id,
            status,
            enrolled_at
          `
          )
          .eq("user_id", student.id)
          .eq("role", "student")
          .eq("status", "active");

        if (enrollmentsError) {
          console.error("Error fetching enrollments:", enrollmentsError);
          return { ...student, courses: [] };
        }

        // Get course details and progress for each enrollment
        const courses = await Promise.all(
          enrollments.map(async (enrollment) => {
            // Get course details
            const { data: course, error: courseError } = await supabase
              .from("courses")
              .select("id, title, description, status")
              .eq("id", enrollment.course_id)
              .single();

            if (courseError || !course) {
              return null;
            }

            // Calculate progress for this course
            const { data: progressData, error: progressError } = await supabase
              .from("user_progress")
              .select("completion_percentage")
              .eq("user_id", student.id)
              .eq("course_id", enrollment.course_id);

            if (progressError) {
              console.error("Error fetching progress:", progressError);
              return {
                id: course.id,
                title: course.title,
                progress: 0,
                status: enrollment.status,
              };
            }

            // Calculate average progress across all content items
            const totalProgress = progressData.reduce(
              (sum, item) => sum + (item.completion_percentage || 0),
              0
            );
            const averageProgress =
              progressData.length > 0
                ? Math.round(totalProgress / progressData.length)
                : 0;

            return {
              id: course.id,
              title: course.title,
              progress: averageProgress,
              status: enrollment.status,
            };
          })
        );

        return {
          ...student,
          courses: courses.filter(Boolean) as StudentCourse[],
        };
      })
    );

    const responsePayload = {
      success: true,
      data: studentsWithCourses,
      count: studentsWithCourses.length,
    };
    await logAudit(reqCtx, "view_students_list", { table: "users" }, { count: studentsWithCourses.length });
    return c.json(responsePayload);
  } catch (error) {
    console.error("Error in /api/students:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

// Get student by ID
app.get("/api/students/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const reqCtx: RequestContext = (c as any).requestContext || (await extractContext(c));

    const { data: student, error: studentError } = await supabase
      .from("users")
      .select(
        `
        id,
        email,
        full_name,
        gender,
        phone_number,
        profile_picture_url,
        bio,
        language_preference,
        created_at
      `
      )
      .eq("id", id)
      .is("deleted_at", null)
      .single();

    if (studentError || !student) {
      return c.json({ success: false, message: "Student not found" }, 404);
    }

    // Get student's courses and progress
    const { data: enrollments, error: enrollmentsError } = await supabase
      .from("enrollments")
      .select(
        `
        course_id,
        status,
        enrolled_at
      `
      )
      .eq("user_id", id)
      .eq("role", "student")
      .eq("status", "active");

    if (enrollmentsError) {
      console.error("Error fetching enrollments:", enrollmentsError);
      return c.json(
        { success: false, message: "Failed to fetch student data" },
        500
      );
    }

    // Get course details and progress
    const courses = await Promise.all(
      enrollments.map(async (enrollment) => {
        const { data: course, error: courseError } = await supabase
          .from("courses")
          .select("id, title, description, status")
          .eq("id", enrollment.course_id)
          .single();

        if (courseError || !course) {
          return null;
        }

        // Calculate progress
        const { data: progressData, error: progressError } = await supabase
          .from("user_progress")
          .select("completion_percentage")
          .eq("user_id", id)
          .eq("course_id", enrollment.course_id);

        const totalProgress =
          progressData?.reduce(
            (sum, item) => sum + (item.completion_percentage || 0),
            0
          ) || 0;
        const averageProgress =
          progressData && progressData.length > 0
            ? Math.round(totalProgress / progressData.length)
            : 0;

        return {
          id: course.id,
          title: course.title,
          progress: averageProgress,
          status: enrollment.status,
        };
      })
    );

    const studentWithCourses = {
      ...student,
      courses: courses.filter(Boolean) as StudentCourse[],
    };

    await logAudit(reqCtx, "view_student", { table: "users", id }, null);
    return c.json({ success: true, data: studentWithCourses });
  } catch (error) {
    console.error("Error in /api/students/:id:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

// Get students by course
app.get("/api/courses/:courseId/students", async (c) => {
  try {
    const courseId = parseInt(c.req.param("courseId"));
    const reqCtx: RequestContext = (c as any).requestContext || (await extractContext(c));

    const { data: enrollments, error: enrollmentsError } = await supabase
      .from("enrollments")
      .select(
        `
        user_id,
        status,
        enrolled_at
      `
      )
      .eq("course_id", courseId)
      .eq("role", "student")
      .eq("status", "active");

    if (enrollmentsError) {
      console.error("Error fetching enrollments:", enrollmentsError);
      return c.json(
        { success: false, message: "Failed to fetch course students" },
        500
      );
    }

    // Get student details for each enrollment
    const students = await Promise.all(
      enrollments.map(async (enrollment) => {
        const { data: student, error: studentError } = await supabase
          .from("users")
          .select(
            `
            id,
            email,
            full_name,
            gender,
            phone_number,
            profile_picture_url,
            bio,
            language_preference,
            created_at
          `
          )
          .eq("id", enrollment.user_id)
          .is("deleted_at", null)
          .single();

        if (studentError || !student) {
          return null;
        }

        // Get progress for this specific course
        const { data: progressData, error: progressError } = await supabase
          .from("user_progress")
          .select("completion_percentage")
          .eq("user_id", enrollment.user_id)
          .eq("course_id", courseId);

        const totalProgress =
          progressData?.reduce(
            (sum, item) => sum + (item.completion_percentage || 0),
            0
          ) || 0;
        const averageProgress =
          progressData && progressData.length > 0
            ? Math.round(totalProgress / progressData.length)
            : 0;

        return {
          ...student,
          courses: [
            {
              id: courseId,
              title: "Current Course", // You might want to fetch the actual course title
              progress: averageProgress,
              status: enrollment.status,
            },
          ],
        };
      })
    );

    const validStudents = students.filter(Boolean) as Student[];

    const payload = {
      success: true,
      data: validStudents,
      count: validStudents.length,
    };
    await logAudit(reqCtx, "view_course_students", { table: "courses", id: String(courseId) }, { count: validStudents.length });
    return c.json(payload);
  } catch (error) {
    console.error("Error in /api/courses/:courseId/students:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

// Get student progress
app.get("/api/students/:id/progress", async (c) => {
  try {
    const id = c.req.param("id");
    const reqCtx: RequestContext = (c as any).requestContext || (await extractContext(c));

    // Get student's enrollments
    const { data: enrollments, error: enrollmentsError } = await supabase
      .from("enrollments")
      .select(
        `
        course_id,
        status
      `
      )
      .eq("user_id", id)
      .eq("role", "student")
      .eq("status", "active");

    if (enrollmentsError) {
      console.error("Error fetching enrollments:", enrollmentsError);
      return c.json(
        { success: false, message: "Failed to fetch student progress" },
        500
      );
    }

    // Get progress for each course
    const courseProgress = await Promise.all(
      enrollments.map(async (enrollment) => {
        const { data: progressData, error: progressError } = await supabase
          .from("user_progress")
          .select("completion_percentage, status")
          .eq("user_id", id)
          .eq("course_id", enrollment.course_id);

        if (progressError) {
          return {
            course_id: enrollment.course_id,
            progress: 0,
            status: "not_started",
          };
        }

        const totalProgress = progressData.reduce(
          (sum, item) => sum + (item.completion_percentage || 0),
          0
        );
        const averageProgress =
          progressData.length > 0
            ? Math.round(totalProgress / progressData.length)
            : 0;
        const completedItems = progressData.filter(
          (item) => item.status === "completed"
        ).length;

        return {
          course_id: enrollment.course_id,
          progress: averageProgress,
          completed_items: completedItems,
          total_items: progressData.length,
          status: enrollment.status,
        };
      })
    );

    const totalCourses = enrollments.length;
    const completedCourses = courseProgress.filter(
      (cp) => cp.progress === 100
    ).length;
    const inProgressCourses = courseProgress.filter(
      (cp) => cp.progress > 0 && cp.progress < 100
    ).length;
    const averageProgress =
      courseProgress.length > 0
        ? Math.round(
            courseProgress.reduce((sum, cp) => sum + cp.progress, 0) /
              courseProgress.length
          )
        : 0;

    const progress = {
      student_id: id,
      total_courses: totalCourses,
      completed_courses: completedCourses,
      in_progress_courses: inProgressCourses,
      average_progress: averageProgress,
      courses: courseProgress,
    };

    await logAudit(reqCtx, "view_student_progress", { table: "users", id }, { total_courses: totalCourses });
    return c.json({ success: true, data: progress });
  } catch (error) {
    console.error("Error in /api/students/:id/progress:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

// Search students
app.get("/api/students/search", async (c) => {
  try {
    const query = c.req.query("q")?.toLowerCase();
    const reqCtx: RequestContext = (c as any).requestContext || (await extractContext(c));

    if (!query) {
      return c.json(
        { success: false, message: "Search query is required" },
        400
      );
    }

    const { data: students, error: studentsError } = await supabase
      .from("users")
      .select(
        `
        id,
        email,
        full_name,
        gender,
        phone_number,
        profile_picture_url,
        bio,
        language_preference,
        created_at
      `
      )
      .is("deleted_at", null)
      .or(
        `full_name.ilike.%${query}%,email.ilike.%${query}%,bio.ilike.%${query}%`
      )
      .order("created_at", { ascending: false });

    if (studentsError) {
      console.error("Error searching students:", studentsError);
      return c.json(
        { success: false, message: "Failed to search students" },
        500
      );
    }

    // Add courses for each student (simplified version)
    const studentsWithCourses = await Promise.all(
      students.map(async (student) => {
        const { data: enrollments } = await supabase
          .from("enrollments")
          .select("course_id, status")
          .eq("user_id", student.id)
          .eq("role", "student")
          .eq("status", "active");

        const courses =
          enrollments?.map((enrollment) => ({
            id: enrollment.course_id,
            title: `Course ${enrollment.course_id}`,
            progress: 0, // You might want to calculate this
            status: enrollment.status,
          })) || [];

        return {
          ...student,
          courses,
        };
      })
    );

    const result = {
      success: true,
      data: studentsWithCourses,
      count: studentsWithCourses.length,
    };
    await logAudit(reqCtx, "search_students", { table: "users" }, { query, results: studentsWithCourses.length });
    return c.json(result);
  } catch (error) {
    console.error("Error in /api/students/search:", error);
    return c.json({ success: false, message: "Internal server error" }, 500);
  }
});

// Errors & 404 (unchanged)
app.onError((err, c) => {
  console.error("Error:", err);
  return c.json({ success: false, message: "Internal server error" }, 500);
});

app.notFound((c) =>
  c.json({ success: false, message: "Endpoint not found" }, 404)
);

// 🔊 Logs
const port = Number(process.env.PORT || 3001);
console.log(`🚀 TeachMe.ai Backend (auto-serve) on port ${port}`);
console.log(`📚 API endpoints:
   GET  /api/students
   POST /api/testing/upload-avatar
   GET  /api/students/:id
   GET  /api/courses/:courseId/students
   GET  /api/students/:id/progress
   GET  /api/students/search?q=query
`);

// 👇 Let Bun auto-serve in dev (no Bun.serve here)
export default {
  port,
  fetch: app.fetch,
};
