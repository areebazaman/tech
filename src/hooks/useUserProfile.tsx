import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './useAuth';
import { useToast } from '@/hooks/use-toast';

interface SocialLink {
  id?: number;
  platform: 'linkedin' | 'facebook' | 'instagram' | 'twitter' | 'github';
  url: string;
  is_public: boolean;
}

interface FormData {
  full_name: string;
  bio: string;
  phone_number: string;
  language_preference: string;
  timezone: string;
  gender: string;
  dob: string;
}

export function useUserProfile() {
  const { profile, updateProfile } = useAuth();
  const { toast } = useToast();
  
  const [formData, setFormData] = useState<FormData>({
    full_name: '',
    bio: '',
    phone_number: '',
    language_preference: 'en',
    timezone: 'UTC',
    gender: 'other',
    dob: ''
  });
  
  const [socialLinks, setSocialLinks] = useState<SocialLink[]>([]);
  const [notificationPreferences, setNotificationPreferences] = useState({
    email: true,
    push: true,
    sms: false
  });
  
  const [isLoadingProfile, setIsLoadingProfile] = useState(false);
  const [uploadingPicture, setUploadingPicture] = useState(false);

  // Load profile data when component mounts
  useEffect(() => {
    if (profile) {
      loadProfileData();
      loadSocialLinks();
    }
  }, [profile]);

  // Real-time subscription for social links changes
  useEffect(() => {
    if (!profile?.id) return;

    const socialLinksSubscription = supabase
      .channel('social-links-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'user_social_links',
          filter: `user_id=eq.${profile.id}`
        },
        async (payload) => {
          console.log('Social links real-time update:', payload);
          // Reload social links when they change
          await loadSocialLinks();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(socialLinksSubscription);
    };
  }, [profile?.id]);

  const loadProfileData = () => {
    if (!profile) return;
    
    setFormData({
      full_name: profile.full_name || '',
      bio: profile.bio || '',
      phone_number: profile.phone_number || '',
      language_preference: profile.language_preference || 'en',
      timezone: profile.timezone || 'UTC',
      gender: profile.gender || 'other',
      dob: profile.dob || ''
    });
    
    if (profile.notification_preferences) {
      setNotificationPreferences(profile.notification_preferences);
    }
  };

  const loadSocialLinks = async () => {
    if (!profile?.id) return;
    
    try {
      const { data, error } = await supabase
        .from('user_social_links')
        .select('*')
        .eq('user_id', profile.id)
        .order('platform');
      
      if (error) throw error;
      setSocialLinks(data || []);
    } catch (error) {
      console.error('Error loading social links:', error);
    }
  };

  const uploadProfilePicture = async (file: File): Promise<string | null> => {
    if (!profile?.id) return null;
    
    setUploadingPicture(true);
    try {
      // Check if avatars bucket exists
      const { data: buckets } = await supabase.storage.listBuckets();
      const avatarsBucket = buckets?.find(bucket => bucket.name === 'Avatar');
      
      if (!avatarsBucket) {
        toast({
          title: "Storage Error",
          description: "Profile picture storage is not configured. Please contact support.",
          variant: "destructive"
        });
        return null;
      }

      // Generate unique filename
      const fileExt = file.name.split('.').pop();
      const fileName = `${Date.now()}.${fileExt}`;
      const filePath = `${profile.id}/${fileName}`;

      // Upload file
      const { data: uploadData, error: uploadError } = await supabase.storage
        .from('Avatar')
        .upload(filePath, file, { 
          cacheControl: '3600', 
          upsert: false 
        });

      if (uploadError) {
        console.error('Upload error:', uploadError);
        toast({
          title: "Upload Failed",
          description: "Failed to upload profile picture. Please try again.",
          variant: "destructive"
        });
        return null;
      }

      // Get public URL
      const { data: { publicUrl } } = supabase.storage
        .from('Avatar')
        .getPublicUrl(filePath);

      return publicUrl;
    } catch (error) {
      console.error('Error uploading profile picture:', error);
      toast({
        title: "Upload Error",
        description: "An error occurred while uploading your profile picture.",
        variant: "destructive"
      });
      return null;
    } finally {
      setUploadingPicture(false);
    }
  };

  const saveSocialLinks = async () => {
    if (!profile?.id) return;
    
    try {
      // Delete existing social links
      await supabase
        .from('user_social_links')
        .delete()
        .eq('user_id', profile.id);

      // Insert new social links
      if (socialLinks.length > 0) {
        const { error } = await supabase
          .from('user_social_links')
          .insert(
            socialLinks.map(link => ({
              user_id: profile.id,
              platform: link.platform,
              url: link.url,
              is_public: link.is_public
            }))
          );

        if (error) throw error;
      }
    } catch (error) {
      console.error('Error saving social links:', error);
      toast({
        title: "Save Failed",
        description: "Failed to save social links. Please try again.",
        variant: "destructive"
      });
    }
  };

  const updateUserProfile = async (profilePicture?: File) => {
    if (!profile?.id) return;
    
    setIsLoadingProfile(true);
    try {
      let profilePictureUrl = null;
      
      if (profilePicture) {
        profilePictureUrl = await uploadProfilePicture(profilePicture);
      }

      const updateData: any = {
        full_name: formData.full_name,
        bio: formData.bio,
        phone_number: formData.phone_number,
        language_preference: formData.language_preference,
        timezone: formData.timezone,
        gender: formData.gender,
        notification_preferences: notificationPreferences
      };

      if (formData.dob) {
        updateData.dob = formData.dob;
      }

      if (profilePictureUrl) {
        updateData.profile_picture_url = profilePictureUrl;
      }

      await updateProfile(updateData);
      await saveSocialLinks();

      toast({
        title: "Profile Updated",
        description: "Your profile has been successfully updated."
      });

      return true;
    } catch (error) {
      console.error('Error updating profile:', error);
      toast({
        title: "Update Failed",
        description: "Failed to update profile. Please try again.",
        variant: "destructive"
      });
      return false;
    } finally {
      setIsLoadingProfile(false);
    }
  };

  const addSocialLink = () => {
    setSocialLinks([...socialLinks, {
      platform: 'linkedin',
      url: '',
      is_public: true
    }]);
  };

  const updateSocialLink = (index: number, field: keyof SocialLink, value: any) => {
    const updatedLinks = [...socialLinks];
    updatedLinks[index] = { ...updatedLinks[index], [field]: value };
    setSocialLinks(updatedLinks);
  };

  const removeSocialLink = (index: number) => {
    setSocialLinks(socialLinks.filter((_, i) => i !== index));
  };

  const updateFormData = (field: keyof FormData, value: string) => {
    setFormData({ ...formData, [field]: value });
  };

  const updateNotificationPreferences = (key: string, value: boolean) => {
    setNotificationPreferences({
      ...notificationPreferences,
      [key]: value
    });
  };

  return {
    formData,
    socialLinks,
    notificationPreferences,
    isLoadingProfile,
    uploadingPicture,
    loadProfileData,
    updateUserProfile,
    addSocialLink,
    updateSocialLink,
    removeSocialLink,
    updateFormData,
    updateNotificationPreferences
  };
}
